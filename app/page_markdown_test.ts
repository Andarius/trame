import { assertEquals, assertMatch } from "@std/assert";
import { markdownToPageBlocks } from "./page-markdown.ts";

const withoutIds = (blocks: ReturnType<typeof markdownToPageBlocks>) =>
  blocks.map(({ id: _id, ...block }) => block);

Deno.test("Markdown becomes native headings and todos without losing other syntax", () => {
  const blocks = markdownToPageBlocks(
    `# Release plan

Intro with **formatting**.

## Checklist

- [x] Ship writer
- [ ] Install skill

\`\`\`ts
const answer = 42;

console.log(answer);
\`\`\``,
    "Release plan",
  );

  assertEquals(withoutIds(blocks), [
    { type: "text", text: "Intro with **formatting**." },
    { type: "heading", text: "Checklist" },
    { type: "todo", text: "Ship writer", done: true },
    { type: "todo", text: "Install skill", done: false },
    {
      type: "text",
      text: "```ts\nconst answer = 42;\n\nconsole.log(answer);\n```",
    },
  ]);
  for (const block of blocks) {
    assertMatch(
      block.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
});

Deno.test("indented todos keep their nesting level", () => {
  assertEquals(
    withoutIds(markdownToPageBlocks(
      "- [ ] parent\n  - [x] child\n\t- [ ] tab child\n      - [ ] deep",
    )),
    [
      { type: "todo", text: "parent", done: false },
      { type: "todo", text: "child", done: true, indent: 1 },
      { type: "todo", text: "tab child", done: false, indent: 1 },
      { type: "todo", text: "deep", done: false, indent: 3 },
    ],
  );
});

Deno.test("a non-matching leading H1 remains content", () => {
  assertEquals(
    withoutIds(markdownToPageBlocks("# Different title\n\nBody", "Page title")),
    [
      { type: "heading", text: "Different title" },
      { type: "text", text: "Body" },
    ],
  );
});
