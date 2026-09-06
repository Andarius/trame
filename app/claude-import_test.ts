import { assertEquals } from "@std/assert";
import { extractCodexMeta } from "./claude-import.ts";

const META = {
  timestamp: "2026-09-03T14:11:10.515Z",
  type: "session_meta",
  payload: {
    id: "01a0679a-ddad-73b0-bfbc-2f62ba0c0f86",
    cwd: "/home/julien/LLMS/Divers",
    cli_version: "0.153.0",
    thread_source: "user",
    git: { branch: "main" },
  },
};
// injected context — a Codex 0.153 launch always logs this, even if the user then quits
const CONTEXT = {
  timestamp: "2026-09-03T14:11:10.857Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>...",
      },
      {
        type: "input_text",
        text:
          "<environment_context>\n  <cwd>/home/julien/LLMS/Divers</cwd>\n</environment_context>",
      },
    ],
  },
};
const PROMPT_153 = {
  timestamp: "2026-09-03T14:11:12.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "can i host this in dedicated scaleway\nmore details",
    }],
  },
};
const PROMPT_152 = {
  timestamp: "2026-09-03T14:11:12.000Z",
  type: "event_msg",
  payload: {
    type: "user_message",
    message: "can i host this in dedicated scaleway",
  },
};
const jsonl = (...entries: unknown[]) =>
  entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

Deno.test("codex meta reads prompts in both the ≤0.152 and 0.153 transcript formats", () => {
  for (
    const [label, prompt] of [["0.152", PROMPT_152], [
      "0.153",
      PROMPT_153,
    ]] as const
  ) {
    const head = jsonl(META, CONTEXT, prompt);
    const meta = extractCodexMeta(head, head);
    assertEquals(meta.hasActivity, true, label);
    assertEquals(
      meta.firstPrompt,
      "can i host this in dedicated scaleway",
      label,
    );
    assertEquals(meta.id, META.payload.id, label);
    assertEquals(meta.cwd, META.payload.cwd, label);
    assertEquals(meta.branch, "main", label);
  }
});

Deno.test("codex 0.153 injected context alone is not activity", () => {
  const head = jsonl(META, CONTEXT);
  const meta = extractCodexMeta(head, head);
  assertEquals(meta.hasActivity, false);
  assertEquals(meta.firstPrompt, null);
});

Deno.test("codex 0.153 prompt only in the tail still counts as activity", () => {
  const meta = extractCodexMeta(jsonl(META, CONTEXT), jsonl(PROMPT_153));
  assertEquals(meta.hasActivity, true);
  assertEquals(meta.firstPrompt, null);
  assertEquals(meta.lastTs, PROMPT_153.timestamp);
});
