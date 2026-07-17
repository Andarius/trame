import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { agentIdentity, resolveCommentBlock } from "./agent-comments.ts";

const CONTENT = [
  { type: "heading", text: "Plan", id: "b1" },
  { type: "text", text: "Ship the first release safely.", id: "b2" },
  { type: "todo", text: "Ship the first release", id: "b3" },
  { type: "folder", path: "/tmp", id: "not-commentable" },
];

Deno.test("comment targets resolve by id, exact quote, then unique substring", () => {
  assertEquals(resolveCommentBlock(CONTENT, { block_id: "b1" }), {
    id: "b1",
    text: "Plan",
  });
  assertEquals(
    resolveCommentBlock(CONTENT, { block_text: "Ship the first release" }),
    { id: "b3", text: "Ship the first release" },
  );
  assertEquals(resolveCommentBlock(CONTENT, { block_text: "safely" }), {
    id: "b2",
    text: "Ship the first release safely.",
  });
});

Deno.test("ambiguous or missing comment targets fail instead of guessing", () => {
  assertThrows(
    () => resolveCommentBlock(CONTENT, { block_text: "Ship" }),
    Error,
    "matches multiple blocks",
  );
  assertThrows(
    () => resolveCommentBlock(CONTENT, {}),
    Error,
    "block_id or unique block_text is required",
  );
});

Deno.test("agent identities contain self-contained branded SVG avatars", () => {
  for (
    const [agent, title] of [["codex", "OpenAI"], [
      "claude",
      "Anthropic",
    ]] as const
  ) {
    const identity = agentIdentity(agent);
    assertEquals(identity.name, agent === "codex" ? "Codex" : "Claude");
    const prefix = "data:image/svg+xml;base64,";
    assertStringIncludes(identity.avatar, prefix);
    const svg = atob(identity.avatar.slice(prefix.length));
    assertStringIncludes(svg, `<title>${title}</title>`);
    assertStringIncludes(svg, "<circle");
    assertStringIncludes(svg, 'fill="white"');
  }
});

Deno.test("any model attributes itself with a generated initial avatar", () => {
  const glm = agentIdentity("glm");
  assertEquals(glm.name, "GLM", "short ids upper-case");
  assertEquals(agentIdentity("gemini").name, "Gemini", "longer ids title-case");
  const svg = atob(glm.avatar.slice("data:image/svg+xml;base64,".length));
  assertStringIncludes(svg, "<circle");
  assertStringIncludes(svg, ">G</text>", "initial in the circle");
  // case-insensitive and independent of the seat
  assertEquals(agentIdentity("GLM").name, "GLM");
});

Deno.test("watcher can run codex/claude built in; other models need a command", async () => {
  const { hasCommand } = await import("../track/watch.ts");
  assert(hasCommand("codex"));
  assert(hasCommand("claude"));
  assertEquals(hasCommand("glm"), false, "no runner → not answerable");
  Deno.env.set("TRAME_WATCH_GLM_CMD", "glm -p {}");
  assert(hasCommand("glm"), "configured runner → answerable");
  Deno.env.delete("TRAME_WATCH_GLM_CMD");
});
