import { expect, test } from "bun:test";
import { agentIdentity, resolveCommentBlock } from "../core/agent-comments.ts";

const CONTENT = [
  { type: "heading", text: "Plan", id: "b1" },
  { type: "text", text: "Ship the first release safely.", id: "b2" },
  { type: "todo", text: "Ship the first release", id: "b3" },
  { type: "folder", path: "/tmp", id: "not-commentable" },
];

test("comment targets resolve by id, exact quote, then unique substring", () => {
  expect(resolveCommentBlock(CONTENT, { block_id: "b1" })).toStrictEqual({
    id: "b1",
    text: "Plan",
  });
  expect(resolveCommentBlock(CONTENT, { block_text: "Ship the first release" })).toStrictEqual({ id: "b3", text: "Ship the first release" });
  expect(resolveCommentBlock(CONTENT, { block_text: "safely" })).toStrictEqual({
    id: "b2",
    text: "Ship the first release safely.",
  });
});

test("ambiguous or missing comment targets fail instead of guessing", () => {
  expect(() => resolveCommentBlock(CONTENT, { block_text: "Ship" })).toThrow("matches multiple blocks");
  expect(() => resolveCommentBlock(CONTENT, {})).toThrow("block_id or unique block_text is required");
});

test("agent identities contain self-contained branded SVG avatars", () => {
  for (
    const [agent, title, name] of [
      ["codex", "OpenAI", "Codex"],
      ["claude", "Anthropic", "Claude"],
      ["glm", "Z.ai", "GLM"],
    ] as const
  ) {
    const identity = agentIdentity(agent);
    expect(identity.name).toStrictEqual(name);
    const prefix = "data:image/svg+xml;base64,";
    expect(identity.avatar).toContain(prefix);
    const svg = atob(identity.avatar.slice(prefix.length));
    expect(svg).toContain(`<title>${title}</title>`);
    expect(svg).toContain("<circle");
    expect(svg).toContain('fill="white"');
  }
});

test("unbranded models attribute themselves with a generated initial avatar", () => {
  const qwen = agentIdentity("qwen");
  expect(qwen.name, "short ids upper-case").toStrictEqual("QWEN");
  expect(agentIdentity("gemini").name, "longer ids title-case").toStrictEqual("Gemini");
  const svg = atob(qwen.avatar.slice("data:image/svg+xml;base64,".length));
  expect(svg).toContain("<circle");
  expect(svg, "initial in the circle").toContain(">Q</text>");
  // case-insensitive and independent of the seat
  expect(agentIdentity("QWEN").name).toStrictEqual("QWEN");
});
