// Changeset sync through the hub API (phase 3, behind the syncViaAPI flag).
// Behaviour-identical to the direct-Postgres path: same scan-based push (own-origin
// rows past the local watermark), same LWW apply on pull — only the transport and
// the pull ordering authority (server change_log rev, not updated_at) change.
import { db } from "./db.ts";
import { NODE_ID, TLS_DIR } from "./config.ts";
import { ENTITIES, PROTOCOL_VERSION } from "../protocol/entities.ts";
import { lwwSoftDelete, lwwUpsert, toParam } from "../protocol/lww.ts";
import type { Change, Mutation, SyncResponse } from "../protocol/types.ts";

// Trust the hub's private CA (fetched by `just db-cert`) for the API's TLS too.
function httpClient(): Deno.HttpClient | undefined {
  try {
    return Deno.createHttpClient({
      caCerts: [Deno.readTextFileSync(`${TLS_DIR}/ca.crt`)],
    });
  } catch {
    return undefined; // no certs — plain HTTP or a publicly trusted cert
  }
}

async function post(
  api: { url: string; token: string },
  body: unknown,
  client: Deno.HttpClient | undefined,
): Promise<SyncResponse> {
  const res = await fetch(`${api.url}/sync`, {
    method: "POST",
    ...(client ? { client } : {}),
    headers: {
      "content-type": "application/json",
      "x-trame-protocol": String(PROTOCOL_VERSION),
      authorization: `Bearer ${api.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `hub API ${res.status}: ${
        (err as { error?: string }).error ?? "sync failed"
      }`,
    );
  }
  return await res.json() as SyncResponse;
}

async function applyChanges(
  pg: Awaited<ReturnType<typeof db>>,
  changes: Change[],
): Promise<number> {
  let applied = 0;
  for (const c of changes) {
    const stmt = c.value === null
      ? lwwSoftDelete(c.entity, c.id, new Date().toISOString())
      : lwwUpsert(c.entity, c.value);
    await pg.query(stmt.text, stmt.params);
    applied++;
  }
  return applied;
}

export async function syncOnceApi(
  api: { url: string; token: string },
): Promise<{ pulled: number; pushed: number }> {
  const pg = await db();
  const client = httpClient();
  const st = (await pg.query(
    `select api_cursor, last_pushed_at from sync_state where id=1`,
  )).rows[0] as { api_cursor: number | string | null; last_pushed_at: string };

  // PUSH assembly — identical selection to the direct path
  const mutations: Mutation[] = [];
  let maxPushed = st.last_pushed_at;
  for (const t of ENTITIES) {
    const rows = (await pg.query(
      `select ${
        t.cols.join(",")
      } from ${t.name} where origin=$1 and updated_at > $2 order by updated_at`,
      [NODE_ID, st.last_pushed_at],
    )).rows as Record<string, unknown>[];
    for (const row of rows) {
      mutations.push({
        // stable across retries of the same row version → idempotent
        mutationId: `${NODE_ID}:${t.name}:${row.id}:${row.updated_at}`,
        entity: t.name,
        id: String(row.id),
        op: "upsert",
        value: Object.fromEntries(
          t.cols.map((c) => [c, toParam(row[c]) ?? null]),
        ),
      });
      if ((row.updated_at as string) > maxPushed) {
        maxPushed = row.updated_at as string;
      }
    }
  }

  let cursor = st.api_cursor === null ? null : Number(st.api_cursor);
  let res = await post({ ...api }, { cursor, mutations }, client);
  const rejected = res.rejectedMutations;
  if (rejected.length) {
    // surfaced, never silently dropped; the watermark stays put so they retry
    console.error("hub API rejected mutations:", rejected);
  }
  let pulled = await applyChanges(pg, res.changes);
  cursor = res.nextCursor;
  while (res.hasMore) {
    res = await post({ ...api }, { cursor, mutations: [] }, client);
    pulled += await applyChanges(pg, res.changes);
    cursor = res.nextCursor;
  }

  // reconcile (same as the direct path): re-promote pages that have sessions if a
  // row-level LWW pull reverted the promotion; pushes back out on the next pass
  await pg.query(
    `update pages set kind='story', origin=$1, updated_at=now()
      where kind='page' and not deleted
        and id in (select page_id from sessions where not deleted and page_id is not null)`,
    [NODE_ID],
  );

  await pg.query(
    `update sync_state set api_cursor=$1, last_pushed_at=$2 where id=1`,
    [cursor, rejected.length ? st.last_pushed_at : maxPushed],
  );
  client?.close();
  return { pulled, pushed: mutations.length - rejected.length };
}
