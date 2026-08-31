// tramecli — the compiled agent CLI (deno task compile:cli). One binary wraps the
// track/ writers so agents need neither deno nor this checkout; --help carries the
// composition conventions from track/help.ts (the single source of truth).
import pc from "picocolors";
import { PORT_FILE } from "../app/config.ts";
import { main as trackMain } from "./track.ts";
import { main as pageMain } from "./page.ts";
import { main as commentMain } from "./comment.ts";
import { main as watchMain } from "./page-watch.ts";
import { run as setupRun } from "./setup.ts";
import {
  COMMENT_HELP,
  LIST_HELP,
  OVERVIEW,
  PAGE_HELP,
  SETUP_HELP,
  TRACK_HELP,
  VERSION,
} from "./help.ts";

const HELP_TOPICS: Record<string, string> = {
  track: TRACK_HELP,
  page: PAGE_HELP,
  comment: COMMENT_HELP,
  list: LIST_HELP,
  setup: SETUP_HELP,
};

type Board = {
  sessions: {
    id: string;
    title: string;
    status: string;
    branch: string | null;
    next_step: string | null;
    pr_url: string | null;
    page_id: string | null;
    deleted: boolean;
  }[];
  stories: { id: string; title: string }[];
  statuses: { key: string; terminal: boolean }[];
};

// flat rows for --json: one object per open session, jq-friendly
export function boardRows(board: Board) {
  const terminal = new Set(
    board.statuses.filter((s) => s.terminal).map((s) => s.key),
  );
  const storyTitle = new Map(board.stories.map((s) => [s.id, s.title]));
  return board.sessions
    .filter((s) => !s.deleted && !terminal.has(s.status))
    .map(({ id, title, status, branch, next_step, pr_url, page_id }) => ({
      id,
      title,
      status,
      story: (page_id && storyTitle.get(page_id)) ?? null,
      branch,
      next_step,
      pr_url,
    }));
}

const STATUS_TINT: Record<string, (s: string) => string> = {
  active: pc.green,
  paused: pc.yellow,
  blocked: pc.red,
};

// Open sessions grouped by story; a status column marked terminal (done, …) hides its
// cards. color=true tints for a terminal (list gates it on TTY, off for --json/pipes).
export function formatBoard(board: Board, color = false): string {
  const terminal = new Set(
    board.statuses.filter((s) => s.terminal).map((s) => s.key),
  );
  const storyTitle = new Map(board.stories.map((s) => [s.id, s.title]));
  const open = board.sessions.filter((s) =>
    !s.deleted && !terminal.has(s.status)
  );
  if (!open.length) return "no open sessions";
  const groups = new Map<string, typeof open>();
  for (const s of open) {
    const key = (s.page_id && storyTitle.get(s.page_id)) ?? "(no story)";
    groups.set(key, [...groups.get(key) ?? [], s]);
  }
  const story = (t: string) => color ? pc.bold(t) : t;
  const status = (k: string) =>
    color ? (STATUS_TINT[k] ?? pc.cyan)(`[${k}]`) : `[${k}]`;
  const next = (t: string) => color ? pc.dim(t) : t;
  return [...groups].map(([title, sessions]) =>
    `${story(title)}\n` +
    sessions.map((s) =>
      `  ${status(s.status)} ${s.title}${s.branch ? ` (${s.branch})` : ""}${
        s.next_step ? next(` — next: ${s.next_step}`) : ""
      }`
    ).join("\n")
  ).join("\n");
}

async function list(json: boolean): Promise<void> {
  let port: number;
  try {
    port = JSON.parse(await Deno.readTextFile(PORT_FILE)).port;
  } catch {
    throw new Error(
      "Trame app is not running (no port file) — nothing to list.",
    );
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/board`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`/api/board → HTTP ${res.status}`);
  const board = await res.json() as Board;
  console.log(
    json
      ? JSON.stringify(boardRows(board))
      : formatBoard(board, Deno.stdout.isTerminal()),
  );
}

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...raw] = argv;
  const json = raw.includes("--json");
  const rest = raw.filter((a) => a !== "--json");
  const wantsHelp = rest.includes("-h") || rest.includes("--help");
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      console.log(OVERVIEW);
      return 0;
    case "help": {
      console.log(HELP_TOPICS[rest[0]] ?? OVERVIEW);
      return 0;
    }
    case "-V":
    case "--version":
      console.log(VERSION);
      return 0;
    case "track":
      if (wantsHelp) console.log(TRACK_HELP);
      else await trackMain(rest, { json });
      return 0;
    case "page":
      if (wantsHelp) console.log(PAGE_HELP);
      else await pageMain(rest);
      return 0;
    case "comment":
      if (wantsHelp) console.log(COMMENT_HELP);
      else await commentMain(rest);
      return 0;
    case "watch": // handles its own --help
      await watchMain(rest);
      return 0;
    case "list":
      if (wantsHelp) console.log(LIST_HELP);
      else await list(json);
      return 0;
    case "setup":
      if (wantsHelp) {
        console.log(SETUP_HELP);
        return 0;
      }
      return await setupRun(rest);
    default:
      console.error(`unknown command: ${cmd}\n\n${OVERVIEW}`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await run(Deno.args));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
