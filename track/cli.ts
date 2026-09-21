// tramecli — the compiled agent CLI (deno task compile:cli). One binary wraps the
// track/ writers so agents need neither deno nor this checkout; --help carries the
// composition conventions from track/help.ts (the single source of truth).
import pc from "picocolors";
import { PORT_FILE } from "../app/config.ts";
import { newer } from "../app/update.ts";
import { main as trackMain } from "./track.ts";
import { main as pageMain } from "./page.ts";
import { main as commentMain } from "./comment.ts";
import { main as watchMain } from "./page-watch.ts";
import { main as answerMain } from "./watch.ts";
import { run as setupRun } from "./setup.ts";
// static: a dynamic import of the npm MCP SDK dies silently under deno compile
import { serve as mcpServe } from "../mcp/server.ts";
import {
  COMMENT_HELP,
  CONVERT_HELP,
  LIST_HELP,
  OVERVIEW,
  PAGE_HELP,
  SETUP_HELP,
  TRACK_HELP,
  UDB_CONTRACT,
  VERSION,
} from "./help.ts";

const HELP_TOPICS: Record<string, string> = {
  track: TRACK_HELP,
  page: PAGE_HELP,
  comment: COMMENT_HELP,
  list: LIST_HELP,
  convert: CONVERT_HELP,
  setup: SETUP_HELP,
  db: UDB_CONTRACT, // topic, not a command: databases are plain REST
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
    repo_path: string | null;
    last_touched: string;
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
    .map((
      { id, title, status, branch, next_step, pr_url, page_id, repo_path, last_touched },
    ) => ({
      id,
      title,
      status,
      story: (page_id && storyTitle.get(page_id)) ?? null,
      branch,
      repo_path,
      last_touched,
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

async function appBase(): Promise<string> {
  try {
    const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
    return `http://127.0.0.1:${port}`;
  } catch {
    throw new Error("Trame app is not running (no port file).");
  }
}

async function list(json: boolean): Promise<void> {
  const res = await fetch(`${await appBase()}/api/board`, {
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

// The page becomes a card whose specs are that page — the page header's
// "Convert to session" button, from a terminal. Idempotent server-side.
async function convert(
  pageId: string | undefined,
  json: boolean,
): Promise<void> {
  if (!pageId) throw new Error("usage: tramecli convert <page-id>");
  const base = await appBase();
  const res = await fetch(`${base}/api/pages/${pageId}/session`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json() as {
    id: string;
    created: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  console.log(
    json
      ? JSON.stringify(body)
      : `ok: session ${body.id} ${
        body.created ? "created from" : "already specced by"
      } this page — ${base}/?session=${body.id}`,
  );
}

const RELEASES = "https://github.com/Andarius/trame/releases/latest";

/**
 * The line to print when the running app is newer than this CLI, or null. A CLI
 * ahead of the app is a dev build, not news. `just setup` only exists in a
 * checkout — an installed CLI is replaced from the release page (the snap ships
 * both, so it cannot drift).
 */
export function staleWarning(
  cli: string,
  app: string | undefined,
  execPath: string,
): string | null {
  if (!app || !newer(app, cli.split("+")[0])) return null;
  const how = execPath.includes("/dist/tramecli") ? "`just setup`" : RELEASES;
  return `a new tramecli is available: ${app} (you have ${cli}) — ${how}`;
}

// stderr, never blocking: a CLI behind the app writes with a stale contract, and the
// symptom (a field the app never sent) is unreadable at the other end.
async function warnIfStale(): Promise<void> {
  try {
    const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
    const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.json()) as { version?: string };
    const line = staleWarning(VERSION, status.version, Deno.execPath());
    if (line) console.error(line);
  } catch { /* no port file, or the app is down: nothing to compare against */ }
}

// the commands that speak to the app — the ones a version mismatch breaks
const APP_COMMANDS = new Set(
  ["track", "page", "comment", "watch", "answer", "list", "convert", "mcp"],
);

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...raw] = argv;
  const json = raw.includes("--json");
  const rest = raw.filter((a) => a !== "--json");
  const wantsHelp = rest.includes("-h") || rest.includes("--help");
  if (!wantsHelp && APP_COMMANDS.has(cmd ?? "")) await warnIfStale();
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
    case "db": // not a command: prints the REST contract, same as `help db`
      console.log(UDB_CONTRACT);
      return 0;
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
    case "answer": // handles its own --help
      await answerMain(rest);
      return 0;
    case "mcp": // stdio MCP server; serves until stdin closes
      await mcpServe();
      return 0;
    case "list":
      if (wantsHelp) console.log(LIST_HELP);
      else await list(json);
      return 0;
    case "convert":
      if (wantsHelp) console.log(CONVERT_HELP);
      else await convert(rest[0], json);
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
    const code = await run(Deno.args);
    // no exit on success: `mcp` keeps serving until stdin closes, and an explicit
    // Deno.exit here would kill it right after connect resolves
    if (code !== 0) Deno.exit(code);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
