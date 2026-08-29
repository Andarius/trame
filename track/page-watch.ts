// Session-watcher poller: heartbeats a scoped watcher badge and exits 0 as soon as a
// page has answerable human feedback — run it in the background from an agent session;
// the harness re-invokes the session when it exits, which then answers and restarts it.
//
//   deno run -A track/page-watch.ts --page <id[,id]> [--agent claude] [--interval 10]
//                                   [--quiet 45] [--stale 600]
//
// Each pass: POST /api/presence (badge TTL is 20s — keep --interval below that), then
// GET /api/comments/inbox?page&mode=all filtered to --agent. Exits 0 once items exist
// AND the newest human comment on the watched pages is older than --quiet seconds
// (the commenter went quiet), printing the pending items as JSON on stdout.
import { PORT_FILE } from "../app/config.ts";
import { AGENT_AUTHOR_ID } from "../app/agent-comments.ts";

const USAGE = `Waits for human feedback on a Trame page, then exits (0 = feedback ready).

Usage: deno run -A track/page-watch.ts --page <id[,id]> [options]

Options:
  --page ID,ID     page ids to watch (required)
  --agent ID       answer as this agent (default: claude)
  --interval SECS  poll + presence heartbeat cadence (default: 10, keep < 20)
  --quiet SECS     required quiet period after the last human comment (default: 45)
  --stale SECS     re-surface stuck "answering…" after this long (default: 600)
  -h, --help       show this help`;

type Flags = {
  pages: string[];
  agent: string;
  interval: number;
  quiet: number;
  stale: number;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = { pages: [], agent: "claude", interval: 10, quiet: 45, stale: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--page") {
      f.pages = val().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--agent") f.agent = val().trim().toLowerCase();
    else if (a === "--interval") f.interval = Number(val());
    else if (a === "--quiet") f.quiet = Number(val());
    else if (a === "--stale") f.stale = Number(val());
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!f.pages.length) throw new Error("--page is required");
  return f;
}

function readBase(): string | null {
  try {
    const port = JSON.parse(Deno.readTextFileSync(PORT_FILE)).port;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function api(base: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

type InboxItem = {
  comment: { id: string; body: string; updated_at: string };
  page: { id: string; title: string };
  block: { id: string; text: string };
  agent: string;
};
type Comment = { author_id: string | null; updated_at: string };

// Newest human comment across the watched pages, epoch ms (0 when none).
async function lastHumanActivity(base: string, pages: string[]): Promise<number> {
  let newest = 0;
  for (const p of pages) {
    const comments = await api(
      base,
      `/api/comments?page=${encodeURIComponent(p)}`,
    ) as Comment[];
    for (const c of comments) {
      if (c.author_id === AGENT_AUTHOR_ID) continue;
      newest = Math.max(newest, Date.parse(c.updated_at) || 0);
    }
  }
  return newest;
}

async function main() {
  if (Deno.args.includes("-h") || Deno.args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const f = parseFlags(Deno.args);
  console.log(
    `watching page(s) ${f.pages.join(",")} for ${f.agent} feedback ` +
      `(every ${f.interval}s, quiet ${f.quiet}s)…`,
  );
  for (;;) {
    const base = readBase();
    if (base) {
      try {
        await api(base, "/api/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ watcher: f.agent, pages: f.pages }),
        });
        const inbox = await api(
          base,
          `/api/comments/inbox?page=${f.pages.join(",")}&mode=all&stale=${f.stale}`,
        ) as InboxItem[];
        const mine = inbox.filter((i) => i.agent === f.agent);
        if (mine.length) {
          const sinceMs = Date.now() - await lastHumanActivity(base, f.pages);
          if (sinceMs > f.quiet * 1000) {
            console.log(
              `${mine.length} pending comment(s) — feedback ready:\n` +
                JSON.stringify(
                  mine.map((i) => ({
                    comment_id: i.comment.id,
                    page: i.page,
                    block_id: i.block.id,
                    body: i.comment.body,
                  })),
                  null,
                  2,
                ),
            );
            return; // exit 0 → the waiting session is re-invoked
          }
          console.log(
            `${mine.length} pending, commenter still active ` +
              `(${Math.round(sinceMs / 1000)}s ago) — waiting for quiet`,
          );
        }
      } catch (e) {
        console.warn(`pass failed: ${(e as Error).message}`);
      }
    } else {
      console.warn("Trame app not running (no port file) — waiting…");
    }
    await new Promise((r) => setTimeout(r, f.interval * 1000));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(2);
  });
}
