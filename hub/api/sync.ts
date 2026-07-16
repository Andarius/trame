// The changeset /sync core (docs/hub-api.md §Sync protocol): mutations up, changes
// down. Push applies the shared LWW rule inside one transaction with trame.actor/
// trame.source set, so the change_log triggers stamp who wrote through the API.
// Pull is cursor-based over change_log (null cursor = full snapshot).
import { ENTITIES, entityByName } from "../../protocol/entities.ts";
import { lwwSoftDelete, lwwUpsert } from "../../protocol/lww.ts";
import type {
  Change,
  Mutation,
  SyncRequest,
  SyncResponse,
} from "../../protocol/types.ts";
import type { DB, Q } from "./db.ts";
import type { Caller } from "./auth.ts";

const DEFAULT_LIMIT = 500;

async function applyMutations(
  db: DB,
  mutations: Mutation[],
  caller: Caller,
): Promise<Pick<SyncResponse, "acknowledgements" | "rejectedMutations">> {
  const acknowledgements: string[] = [];
  const rejectedMutations: { mutationId: string; reason: string }[] = [];
  if (!mutations.length) return { acknowledgements, rejectedMutations };

  await db.transaction(async (tx) => {
    await tx.query(`select set_config('trame.source', 'api', true)`);
    await tx.query(`select set_config('trame.actor', $1, true)`, [
      caller.userId ?? "",
    ]);
    for (const m of mutations) {
      // savepoint per mutation: an error must reject only THIS one, not abort the
      // batch txn ("ack the good, reject the bad, never stall the queue")
      await tx.query(`savepoint m`);
      try {
        const stmt = m.op === "delete"
          ? lwwSoftDelete(
            m.entity,
            m.id,
            String(m.value?.updated_at ?? new Date().toISOString()),
          )
          : lwwUpsert(m.entity, m.value);
        await tx.query(stmt.text, stmt.params);
        await tx.query(`release savepoint m`);
        // LWW no-op (older than what we hold) still acks — the queue must drain
        acknowledgements.push(m.mutationId);
      } catch (e) {
        await tx.query(`rollback to savepoint m`);
        rejectedMutations.push({
          mutationId: m.mutationId,
          reason: String((e as Error)?.message ?? e).slice(0, 300),
        });
      }
    }
  });
  return { acknowledgements, rejectedMutations };
}

async function hydrate(
  db: Q,
  entity: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const e = entityByName.get(entity)!;
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  const rows = await db.query(
    `select ${e.cols.join(",")} from ${e.name} where id in (${ph})`,
    ids,
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

// Full snapshot for a first sync (or a device offline past change_log compaction):
// every row of every entity, tombstones included, cursor = the log head BEFOREHAND
// so anything written during the snapshot is re-delivered incrementally (idempotent).
async function snapshot(
  db: Q,
  limitIgnored: number,
): Promise<Pick<SyncResponse, "changes" | "nextCursor" | "hasMore">> {
  void limitIgnored; // a snapshot is always complete — partial snapshots can't resume
  const head = await db.query(
    `select coalesce(max(rev), 0)::bigint as rev from change_log`,
  );
  const nextCursor = Number(head[0].rev);
  const changes: Change[] = [];
  for (const e of ENTITIES) {
    const rows = await db.query(`select ${e.cols.join(",")} from ${e.name}`);
    for (const r of rows) {
      changes.push({
        rev: nextCursor,
        entity: e.name,
        id: String(r.id),
        value: r,
      });
    }
  }
  return { changes, nextCursor, hasMore: false };
}

async function pullSince(
  db: Q,
  cursor: number,
  limit: number,
): Promise<Pick<SyncResponse, "changes" | "nextCursor" | "hasMore">> {
  // coalesce repeats within the window to the latest rev per row
  const log = await db.query(
    `select entity, row_id, max(rev)::bigint as rev
       from change_log where rev > $1
      group by entity, row_id
      order by max(rev)
      limit $2`,
    [cursor, limit],
  ) as { entity: string; row_id: string; rev: string | number }[];
  if (!log.length) return { changes: [], nextCursor: cursor, hasMore: false };

  const byEntity = new Map<string, string[]>();
  for (const l of log) {
    if (!entityByName.has(l.entity)) continue; // e.g. a table this protocol version doesn't know
    byEntity.set(l.entity, [...byEntity.get(l.entity) ?? [], l.row_id]);
  }
  const hydrated = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [entity, ids] of byEntity) {
    hydrated.set(entity, await hydrate(db, entity, ids));
  }
  const changes: Change[] = [];
  for (const l of log) {
    if (!entityByName.has(l.entity)) continue;
    changes.push({
      rev: Number(l.rev),
      entity: l.entity as Change["entity"],
      id: l.row_id,
      value: hydrated.get(l.entity)?.get(l.row_id) ?? null, // null = hard-deleted → tombstone
    });
  }
  return {
    changes,
    nextCursor: Number(log[log.length - 1].rev),
    hasMore: log.length === limit,
  };
}

export async function handleSync(
  db: DB,
  req: SyncRequest,
  caller: Caller,
): Promise<SyncResponse> {
  const pushed = await applyMutations(db, req.mutations, caller);
  const limit = Math.min(req.limit ?? DEFAULT_LIMIT, 2000);
  const pulled = req.cursor === null
    ? await snapshot(db, limit)
    : await pullSince(db, req.cursor, limit);
  return { ...pushed, ...pulled };
}
