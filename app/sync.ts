// Custom last-write-wins sync between local PGlite and the mini's Postgres.
// Single user => LWW by `updated_at` is trivially correct. `origin` marks who wrote
// a row so PUSH only sends genuine local changes (not rows we just pulled).
//
// Watermarks: PULL compares against remote-clock timestamps; PUSH against local-clock.
// We store the max timestamp actually seen (not now()) to be robust to clock skew.
import postgres from "postgres";
import { db } from "./db.ts";
import { NODE_ID, REMOTE_PG } from "./config.ts";

export const TABLES = [
  { name: "clients", cols: ["id", "name", "color", "origin", "updated_at", "deleted"] },
  // pages replaced objectives (same ids); it must sync before every table that FKs it.
  // parent_id has no FK, so updated_at-ordered pulls within the table are safe.
  { name: "pages", cols: ["id", "parent_id", "kind", "title", "icon", "story", "client_id", "status", "content", "sort_key", "origin", "updated_at", "deleted"] },
  { name: "sessions", cols: ["id", "title", "status", "client_id", "objective_id", "page_id", "repo_path", "branch", "next_step", "pr_url", "summary", "last_touched", "origin", "updated_at", "deleted"] },
  { name: "session_events", cols: ["id", "session_id", "at", "summary", "kind", "origin", "updated_at", "deleted"] },
  { name: "reports", cols: ["id", "title", "html", "client_id", "objective_id", "page_id", "created_at", "origin", "updated_at", "deleted"] },
  { name: "udb_databases", cols: ["id", "name", "icon", "page_id", "sort_key", "views", "origin", "updated_at", "deleted"] },
  { name: "udb_properties", cols: ["id", "db_id", "name", "type", "config", "sort_key", "width", "origin", "updated_at", "deleted"] },
  { name: "udb_rows", cols: ["id", "db_id", "icon", "vals", "sort_key", "origin", "updated_at", "deleted"] },
  { name: "udb_links", cols: ["id", "prop_id", "from_row", "to_row", "origin", "updated_at", "deleted"] },
] as const;

function localUpsert(name: string, cols: readonly string[]) {
  const ph = cols.map((_, i) => `$${i + 1}`).join(",");
  const set = cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",");
  return `insert into ${name} (${cols.join(",")}) values (${ph})
          on conflict (id) do update set ${set}
          where excluded.updated_at > ${name}.updated_at`;
}

export async function syncOnce(): Promise<{ pulled: number; pushed: number } | null> {
  if (!REMOTE_PG) { console.warn("TRACKER_REMOTE_PG unset — offline-only, skipping sync"); return null; }
  const pg = await db();
  let remote: ReturnType<typeof postgres> | null = null;
  try {
    remote = postgres(REMOTE_PG, { connect_timeout: 5, idle_timeout: 5 });
    const st = (await pg.query(`select last_pulled_at, last_pushed_at from sync_state where id=1`)).rows[0] as
      { last_pulled_at: string; last_pushed_at: string };
    let pulled = 0, pushed = 0;
    let maxPulled = st.last_pulled_at, maxPushed = st.last_pushed_at;

    // PULL: remote -> local (dependency order so FKs resolve).
    for (const t of TABLES) {
      const rows = await remote`select ${remote(t.cols as unknown as string[])} from ${remote(t.name)}
                                where updated_at > ${st.last_pulled_at} order by updated_at`;
      for (const row of rows) {
        await pg.query(localUpsert(t.name, t.cols), t.cols.map((c) => (row as Record<string, unknown>)[c]));
        if ((row.updated_at as string) > maxPulled) maxPulled = row.updated_at as string;
        pulled++;
      }
    }

    // PUSH: local rows written by THIS node -> remote.
    for (const t of TABLES) {
      const rows = (await pg.query(
        `select ${t.cols.join(",")} from ${t.name} where origin=$1 and updated_at > $2 order by updated_at`,
        [NODE_ID, st.last_pushed_at],
      )).rows as Record<string, unknown>[];
      const settable = t.cols.filter((c) => c !== "id") as unknown as string[];
      for (const row of rows) {
        await remote`insert into ${remote(t.name)} ${remote(row, ...(t.cols as unknown as string[]))}
                     on conflict (id) do update set ${remote(row, ...settable)}
                     where excluded.updated_at > ${remote(t.name)}.updated_at`;
        if ((row.updated_at as string) > maxPushed) maxPushed = row.updated_at as string;
        pushed++;
      }
    }

    await pg.query(`update sync_state set last_pulled_at=$1, last_pushed_at=$2 where id=1`, [maxPulled, maxPushed]);
    return { pulled, pushed };
  } finally {
    await remote?.end({ timeout: 2 });
  }
}

if (import.meta.main && Deno.args[0] === "once") {
  console.log(await syncOnce());
}
