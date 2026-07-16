// Custom last-write-wins sync between local PGlite and the hub's Postgres.
// Single user => LWW by `updated_at` is trivially correct. `origin` marks who wrote
// a row so PUSH only sends genuine local changes (not rows we just pulled).
//
// Watermarks: PULL compares against remote-clock timestamps; PUSH against local-clock.
// We store the max timestamp actually seen (not now()) to be robust to clock skew.
import postgres from "postgres";
import { checkServerIdentity } from "node:tls";
import { db } from "./db.ts";
import { NODE_ID, TLS_DIR } from "./config.ts";
import { getRemotePg } from "./files.ts";

// mTLS to the hub when certs exist (fetched by `just db-cert`); without them we try
// plaintext and a TLS-enforcing hub rejects with a clear pg_hba error.
// `servername` pins verification to the hub cert's DNS SAN — postgres.js passes the
// ssl object straight to tls.connect(), and for IP hosts it sets no servername, so
// node's identity check would otherwise fall back to a wrong host string.
function hubTls() {
  try {
    return {
      ca: Deno.readTextFileSync(`${TLS_DIR}/ca.crt`),
      cert: Deno.readTextFileSync(`${TLS_DIR}/client.crt`),
      key: Deno.readTextFileSync(`${TLS_DIR}/client.key`),
      servername: "tracker-hub",
      checkServerIdentity: (_host: string, cert: unknown) =>
        checkServerIdentity("tracker-hub", cert as never),
    };
  } catch {
    console.warn(
      `no TLS certs in ${TLS_DIR} — run 'just db-cert'; trying plaintext`,
    );
    return undefined;
  }
}

// Probe a hub URL: connect (mTLS when certs exist), report TLS state or the error.
export async function testRemote(
  url: string,
): Promise<{ ok: boolean; tls?: boolean; error?: string }> {
  let remote: ReturnType<typeof postgres> | null = null;
  try {
    remote = postgres(url, {
      connect_timeout: 5,
      idle_timeout: 5,
      max: 1,
      ssl: hubTls(),
    });
    const [row] =
      await remote`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
    return { ok: true, tls: Boolean(row?.ssl) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // belt and braces: never echo a URL (it could carry the password)
    return {
      ok: false,
      error: msg.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…"),
    };
  } finally {
    await remote?.end({ timeout: 2 }).catch(() => {});
  }
}

export const TABLES = [
  {
    name: "clients",
    cols: ["id", "name", "color", "origin", "updated_at", "deleted"],
  },
  // pages replaced objectives (same ids); it must sync before every table that FKs it.
  // parent_id has no FK, so updated_at-ordered pulls within the table are safe.
  {
    name: "pages",
    cols: [
      "id",
      "parent_id",
      "kind",
      "title",
      "icon",
      "story",
      "client_id",
      "status",
      "content",
      "color",
      "sort_key",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "page_comments",
    cols: [
      "id",
      "page_id",
      "block_id",
      "anchor",
      "body",
      "author",
      "author_avatar",
      "resolved",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "statuses",
    cols: [
      "id",
      "key",
      "label",
      "color",
      "terminal",
      "sort_key",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "sessions",
    cols: [
      "id",
      "title",
      "status",
      "client_id",
      "objective_id",
      "page_id",
      "repo_path",
      "branch",
      "next_step",
      "pr_url",
      "summary",
      "claude_id",
      "agent",
      "last_touched",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "session_events",
    cols: [
      "id",
      "session_id",
      "at",
      "summary",
      "kind",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "reports",
    cols: [
      "id",
      "title",
      "html",
      "client_id",
      "objective_id",
      "page_id",
      "created_at",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "udb_databases",
    cols: [
      "id",
      "name",
      "icon",
      "page_id",
      "sort_key",
      "views",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "udb_properties",
    cols: [
      "id",
      "db_id",
      "name",
      "type",
      "config",
      "sort_key",
      "width",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "udb_rows",
    cols: [
      "id",
      "db_id",
      "icon",
      "vals",
      "sort_key",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
  {
    name: "udb_links",
    cols: [
      "id",
      "prop_id",
      "from_row",
      "to_row",
      "origin",
      "updated_at",
      "deleted",
    ],
  },
] as const;

function localUpsert(name: string, cols: readonly string[]) {
  const ph = cols.map((_, i) => `$${i + 1}`).join(",");
  const set = cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`)
    .join(",");
  return `insert into ${name} (${cols.join(",")}) values (${ph})
          on conflict (id) do update set ${set}
          where excluded.updated_at > ${name}.updated_at`;
}

export async function syncOnce(): Promise<
  { pulled: number; pushed: number } | null
> {
  // settings.json (⚙ in the app) wins over TRACKER_REMOTE_PG — re-read every pass
  const remotePg = await getRemotePg();
  if (!remotePg) {
    console.warn(
      "no hub configured (⚙ Settings or TRACKER_REMOTE_PG) — offline-only, skipping sync",
    );
    return null;
  }
  const pg = await db();
  let remote: ReturnType<typeof postgres> | null = null;
  try {
    remote = postgres(remotePg, {
      connect_timeout: 5,
      idle_timeout: 5,
      ssl: hubTls(),
    });
    const st = (await pg.query(
      `select last_pulled_at, last_pushed_at from sync_state where id=1`,
    )).rows[0] as { last_pulled_at: string; last_pushed_at: string };
    let pulled = 0, pushed = 0;
    let maxPulled = st.last_pulled_at, maxPushed = st.last_pushed_at;

    // PULL: remote -> local (dependency order so FKs resolve).
    for (const t of TABLES) {
      const rows = await remote`select ${
        remote(t.cols as unknown as string[])
      } from ${remote(t.name)}
                                where updated_at > ${st.last_pulled_at} order by updated_at`;
      for (const row of rows) {
        await pg.query(
          localUpsert(t.name, t.cols),
          t.cols.map((c) => (row as Record<string, unknown>)[c]),
        );
        if ((row.updated_at as string) > maxPulled) {
          maxPulled = row.updated_at as string;
        }
        pulled++;
      }
    }

    // reconcile: row-level LWW can revert a promotion (a concurrent page edit from
    // another node still carrying kind='page' wins the whole row) — re-promote any
    // page that has sessions; writes only on violation, then pushes back out below
    await pg.query(
      `update pages set kind='story', origin=$1, updated_at=now()
        where kind='page' and not deleted
          and id in (select page_id from sessions where not deleted and page_id is not null)`,
      [NODE_ID],
    );

    // PUSH: local rows written by THIS node -> remote.
    for (const t of TABLES) {
      const rows = (await pg.query(
        `select ${
          t.cols.join(",")
        } from ${t.name} where origin=$1 and updated_at > $2 order by updated_at`,
        [NODE_ID, st.last_pushed_at],
      )).rows as Record<string, unknown>[];
      const settable = t.cols.filter((c) => c !== "id") as unknown as string[];
      for (const row of rows) {
        await remote`insert into ${remote(t.name)} ${
          remote(row, ...(t.cols as unknown as string[]))
        }
                     on conflict (id) do update set ${remote(row, ...settable)}
                     where excluded.updated_at > ${remote(t.name)}.updated_at`;
        if ((row.updated_at as string) > maxPushed) {
          maxPushed = row.updated_at as string;
        }
        pushed++;
      }
    }

    await pg.query(
      `update sync_state set last_pulled_at=$1, last_pushed_at=$2 where id=1`,
      [maxPulled, maxPushed],
    );
    return { pulled, pushed };
  } finally {
    await remote?.end({ timeout: 2 });
  }
}

if (import.meta.main && Deno.args[0] === "once") {
  console.log(await syncOnce());
}
