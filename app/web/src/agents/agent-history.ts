import type { HistoryItem } from "../api";
import { fmtDuration } from "./agent-summary";

export type Tool = Extract<HistoryItem, { kind: "tool" }>;
export type Result = Extract<HistoryItem, { kind: "result" }>;
export type Keyed = { key: number; item: HistoryItem };
// a prompt and everything the agent did for it; the first turn of a page may start mid-turn
export type Turn = { key: number; prompt: Keyed | null; body: Keyed[] };
export type DiffLine = { sign: "+" | "-"; text: string };
export type FileDiff = { file: string; lines: DiffLine[] };

type Kind = "read" | "search" | "run" | "edit" | "other";
const KINDS: Record<string, Kind> = {
  Read: "read",
  NotebookRead: "read",
  view_image: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebSearch: "search",
  WebFetch: "search",
  web_search: "search",
  Bash: "run",
  BashOutput: "run",
  shell: "run",
  exec_command: "run",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  apply_patch: "edit",
};
export const toolKind = (name: string): Kind => KINDS[name] ?? "other";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const base = (p: string) => p.split("/").pop() ?? p;

// the argument Claude Code prints after the tool name: `Bash(cargo test)`, `Edit(pty.rs)`
export const toolArg = ({ input }: Tool) => {
  const cmd = input.command;
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const arg = str(cmd) ?? (Array.isArray(cmd) ? cmd.join(" ") : undefined) ?? str(input.cmd) ??
    (path && base(path)) ?? str(input.pattern) ?? str(input.description) ?? str(input.url) ?? str(input.query) ??
    str(input.skill);
  const line = arg?.split("\n")[0].trim();
  return line && line.length > 80 ? `${line.slice(0, 80)}…` : line ?? "";
};

const WORDS: Record<Kind, [string, string]> = {
  read: ["read", "file"],
  search: ["searched", "time"],
  run: ["ran", "command"],
  edit: ["edited", "file"],
  other: ["used", "tool"],
};
// what a run of calls did, in order of first use: "read 2 files, ran 1 command"
export function runSentence(tools: Tool[]): string {
  const counts = new Map<Kind, number>();
  for (const t of tools) counts.set(toolKind(t.name), (counts.get(toolKind(t.name)) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${WORDS[k][0]} ${n} ${WORDS[k][1]}${n > 1 ? "s" : ""}`).join(", ");
}

export function toTurns(items: Keyed[]): Turn[] {
  const out: Turn[] = [];
  for (const k of items) {
    const previous = out.at(-1);
    if (k.item.kind === "user") out.push({ key: k.key, prompt: k, body: [] });
    else if (previous && k.item.kind !== "compaction" && previous.body[0]?.item.kind !== "compaction") previous.body.push(k);
    else out.push({ key: k.key, prompt: null, body: [k] });
  }
  return out;
}

// the reply that closes a turn: its last text, once no call follows it
export function finalReply(turn: Turn): Keyed | null {
  for (let i = turn.body.length - 1; i >= 0; i--) {
    const { kind } = turn.body[i].item;
    if (kind === "assistant") return turn.body[i];
    if (kind === "tool" || kind === "result") return null;
  }
  return null;
}

const lines = (s: string, sign: DiffLine["sign"]) => (s ? s.replace(/\n$/, "").split("\n").map((text) => ({ sign, text })) : []);

// Codex patches: `*** Update File: path` sections of `+`/`-` lines
function patchDiffs(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const line of patch.split("\n")) {
    const head = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) out.push({ file: head[1].trim(), lines: [] });
    else if (out.length && (line.startsWith("+") || line.startsWith("-"))) {
      out[out.length - 1].lines.push({ sign: line[0] as DiffLine["sign"], text: line.slice(1) });
    }
  }
  return out;
}

// what an edit call changed, per file; null for calls that change nothing
export function toolDiffs(tool: Tool): FileDiff[] | null {
  const { name, input } = tool;
  const file = str(input.file_path) ?? str(input.notebook_path) ?? "";
  if (name === "Edit" || name === "NotebookEdit") {
    const o = str(input.old_string) ?? "", n = str(input.new_string) ?? str(input.new_source) ?? "";
    return [{ file, lines: [...lines(o, "-"), ...lines(n, "+")] }];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits as Record<string, unknown>[];
    return [{ file, lines: edits.flatMap((e) => [...lines(str(e.old_string) ?? "", "-"), ...lines(str(e.new_string) ?? "", "+")]) }];
  }
  if (name === "Write") return [{ file, lines: lines(str(input.content) ?? "", "+") }];
  const cmd = input.command;
  const patch = name === "apply_patch"
    ? str(input.input) ?? str(input.patch)
    : Array.isArray(cmd) && cmd[0] === "apply_patch" ? str(cmd[1]) : undefined;
  return patch ? patchDiffs(patch) : null;
}

// lines added and removed per file across the loaded history, in first-touched order
export function fileChanges(items: Keyed[]): { file: string; add: number; del: number }[] {
  const by = new Map<string, { file: string; add: number; del: number }>();
  for (const { item } of items) {
    if (item.kind !== "tool") continue;
    for (const d of toolDiffs(item) ?? []) {
      if (!d.file) continue;
      const row = by.get(d.file) ?? { file: d.file, add: 0, del: 0 };
      for (const l of d.lines) l.sign === "+" ? row.add++ : row.del++;
      by.set(d.file, row);
    }
  }
  return [...by.values()];
}

// how long a turn ran: from its prompt to its last line, or to now while it still runs
export function turnSpan(turn: Turn, now?: number): string | null {
  const first = Date.parse(turn.prompt?.item.ts ?? turn.body[0]?.item.ts ?? "");
  const last = now ?? Date.parse([...turn.body].reverse().find((k) => k.item.ts)?.item.ts ?? "");
  if (Number.isNaN(first) || Number.isNaN(last)) return null;
  const s = Math.max(0, Math.round((last - first) / 1000));
  return s < 60 ? `${s}s` : fmtDuration(s * 1000);
}
