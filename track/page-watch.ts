// Session-watcher poller: heartbeats a scoped watcher badge and exits 0 as soon as a
// page has answerable human feedback — run it in the background from an agent session;
// the harness re-invokes the session when it exits, which then answers and restarts it.
//
//   tramecli watch [--page <id-or-title[,…]>] [--agent claude] [--interval 10]
//                  [--quiet 45] [--stale 600]
//
// No --page: the `page_id` in ./.plan-trame.json.
//
// Each pass: POST /api/presence (badge TTL is 20s — keep --interval below that), then
// GET /api/comments/inbox?page&mode=all filtered to --agent. Exits 0 once items exist
// AND the newest human comment on the watched pages is older than --quiet seconds
// (the commenter went quiet), printing the pending items as JSON on stdout.
import { PORT_FILE } from "../app/config.ts";
import { AGENT_AUTHOR_ID } from "../app/agent-comments.ts";
import { resolvePages } from "./watch.ts";

const USAGE = `Waits for human feedback on a Trame page, then exits (0 = feedback ready).

Usage: tramecli watch [--page <id-or-title[,…]>] [options]

Options:
  --page P,P       pages to watch, by id or exact title, subpages included
                   (default: page_id from ./.plan-trame.json)
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
  if (!f.pages.length) f.pages = planPages();
  if (!f.pages.length) {
    throw new Error(
      "no page to watch — pass --page <id-or-title>, or run from a project with .plan-trame.json",
    );
  }
  return f;
}

// Fallback selector: the plan page recorded by /trame:plan-export.
function planPages(): string[] {
  try {
    const id = JSON.parse(Deno.readTextFileSync(".plan-trame.json")).page_id;
    return id ? [String(id)] : [];
  } catch {
    return [];
  }
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

// Badge writes are advisory — a failing one must never break the watch loop.
// "seen" keeps the item in the inbox (it is a display ack); "answering" claims it.
const setStatus = (base: string, id: string, status: string, agent: string) =>
  api(base, `/api/comments/${id}/agent-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, agent }),
  }).catch(() => {});

// A standalone `tramecli answer` covering every page would answer the same threads
// as this session — say so rather than double-answering silently.
async function warnOnGlobalWatcher(base: string, page: string, agent: string) {
  try {
    const here = await api(
      base,
      `/api/presence?page=${encodeURIComponent(page)}`,
    ) as { id: string; page_id: string }[];
    if (here.some((p) => p.id === `watcher:${agent}` && p.page_id === "*")) {
      console.warn(
        `warning: a global ${agent} watcher is running — both may answer the same thread`,
      );
    }
  } catch {
    // preflight only — never block the watch on it
  }
}

export async function main(argv: string[] = Deno.args) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const f = parseFlags(argv);
  const first = readBase();
  if (first) {
    f.pages = [...await resolvePages(first, new Set(f.pages))];
    if (!f.pages.length) throw new Error("no page matched (by id or title)");
    await warnOnGlobalWatcher(first, f.pages[0], f.agent);
  }
  console.log(
    `watching page(s) ${f.pages.join(",")} for ${f.agent} feedback ` +
      `(every ${f.interval}s, quiet ${f.quiet}s)…`,
  );
  const acked = new Set<string>(); // comments already marked seen this run
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
          // "✓ saw this" the moment we pick it up, so the quiet window isn't dead
          // air on the page. Once per comment — a write per pass is sync churn.
          for (const i of mine) {
            if (acked.has(i.comment.id)) continue;
            acked.add(i.comment.id);
            await setStatus(base, i.comment.id, "seen", f.agent);
          }
          const sinceMs = Date.now() - await lastHumanActivity(base, f.pages);
          if (sinceMs > f.quiet * 1000) {
            // handing off to the session that composes the reply: claim the threads
            // so "⟳ answering…" pulses and a global watcher can't double-answer
            for (const i of mine) {
              await setStatus(base, i.comment.id, "answering", f.agent);
            }
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
