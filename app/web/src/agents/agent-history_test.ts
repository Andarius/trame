import { describe, expect, test } from "bun:test";
import type { HistoryItem } from "../api";
import { fileChanges, finalReply, type Keyed, runSentence, type Tool, toolDiffs, toTurns, turnSpan } from "./agent-history";

const tool = (name: string, input: Record<string, unknown>): Tool => ({ kind: "tool", id: name, name, input });
const keyed = (items: HistoryItem[]): Keyed[] => items.map((item, key) => ({ key, item }));
const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 21, 0, s)).toISOString();

describe("runSentence counts calls by kind, in first-use order", () => {
  for (
    const [id, tools, expected] of [
      ["mixed", [tool("Read", {}), tool("Grep", {}), tool("Read", {}), tool("Bash", {})], "read 2 files, searched 1 time, ran 1 command"],
      ["codex names", [tool("exec_command", {}), tool("apply_patch", {})], "ran 1 command, edited 1 file"],
      ["unknown tools", [tool("TodoWrite", {}), tool("Agent", {})], "used 2 tools"],
    ] as const
  ) test(id, () => expect(runSentence([...tools])).toBe(expected));
});

describe("turns split at prompts and keep their closing reply", () => {
  for (
    const [id, items, prompts, reply] of [
      ["reply after the last call", [
        { kind: "user", text: "fix it", truncated: false },
        { kind: "assistant", text: "looking", truncated: false },
        tool("Bash", { command: "npm test" }),
        { kind: "result", toolId: "Bash", text: "ok", error: false, truncated: false },
        { kind: "assistant", text: "fixed", truncated: false },
      ], [true], "fixed"],
      ["still working: a call is the last thing", [
        { kind: "user", text: "fix it", truncated: false },
        { kind: "assistant", text: "looking", truncated: false },
        tool("Bash", { command: "npm test" }),
      ], [true], null],
      ["a page that starts mid-turn", [
        { kind: "assistant", text: "done", truncated: false },
        { kind: "user", text: "next", truncated: false },
      ], [false, true], "done"],
    ] as const
  ) {
    test(id, () => {
      const turns = toTurns(keyed([...items] as HistoryItem[]));
      expect(turns.map((t) => !!t.prompt)).toEqual([...prompts]);
      const r = finalReply(turns[0])?.item;
      expect(r?.kind === "assistant" ? r.text : null).toBe(reply);
    });
  }
});

describe("toolDiffs reads Claude edits and Codex patches", () => {
  for (
    const [id, t, expected] of [
      ["Edit", tool("Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y\nz" }), [{ file: "/w/a.ts", lines: ["-x", "+y", "+z"] }]],
      ["Write", tool("Write", { file_path: "/w/b.ts", content: "one\ntwo\n" }), [{ file: "/w/b.ts", lines: ["+one", "+two"] }]],
      ["apply_patch", tool("apply_patch", {
        input: "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n*** Add File: src/b.rs\n+fresh\n*** End Patch",
      }), [{ file: "src/a.rs", lines: ["-old", "+new"] }, { file: "src/b.rs", lines: ["+fresh"] }]],
      ["not an edit", tool("Bash", { command: "ls" }), null],
    ] as const
  ) {
    test(id, () => {
      const d = toolDiffs(t);
      expect(d?.map((f) => ({ file: f.file, lines: f.lines.map((l) => l.sign + l.text) })) ?? null).toEqual(
        expected && expected.map((f) => ({ file: f.file, lines: [...f.lines] })),
      );
    });
  }
});

test("fileChanges sums lines per file across calls", () => {
  const items = keyed([
    tool("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
    tool("Bash", { command: "ls" }),
    tool("Edit", { file_path: "a.ts", old_string: "", new_string: "z" }),
    tool("Write", { file_path: "b.ts", content: "1\n2" }),
  ]);
  expect(fileChanges(items)).toEqual([{ file: "a.ts", add: 2, del: 1 }, { file: "b.ts", add: 2, del: 0 }]);
});

test("turnSpan runs from the prompt to the last line, or to now", () => {
  const [turn] = toTurns(keyed([
    { kind: "user", text: "go", truncated: false, ts: at(0) },
    { kind: "assistant", text: "done", truncated: false, ts: at(42) },
  ]));
  expect(turnSpan(turn)).toBe("42s");
  expect(turnSpan(turn, Date.parse(at(0)) + 185_000)).toBe("3 min");
});
