import { assertEquals, assertMatch } from "@std/assert";
import { markdownToPageBlocks, pageBlocksToMarkdown } from "./page-markdown.ts";

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

Deno.test("pageBlocksToMarkdown round-trips through markdownToPageBlocks", () => {
  const markdown = `Intro paragraph.

## Checklist

- [x] Ship writer
- [ ] Install skill
  - [ ] on the mac

\`\`\`ts
const answer = 42;

console.log(answer);
\`\`\`
`;
  const blocks = markdownToPageBlocks(markdown);
  const rendered = pageBlocksToMarkdown(blocks);
  assertEquals(withoutIds(markdownToPageBlocks(rendered)), withoutIds(blocks));
  // structural blocks are skipped, never serialized
  assertEquals(
    pageBlocksToMarkdown([{ type: "subpage", page_id: "x" }, {
      type: "heading",
      text: "Goal",
    }]),
    "## Goal\n",
  );
  assertEquals(pageBlocksToMarkdown([]), "");
});

Deno.test("a lone {{trame:folder=...}} line becomes a folder block", () => {
  assertEquals(
    withoutIds(markdownToPageBlocks(
      `## Artefacts

{{trame:folder=~/LLMS/Soren/compliance}}

{{trame:folder=./reports}} {{trame:view=gallery}}`,
    )),
    [
      { type: "heading", text: "Artefacts" },
      { type: "folder", path: "~/LLMS/Soren/compliance", view: "list" },
      { type: "folder", path: "./reports", view: "gallery" },
    ],
  );
});

Deno.test("a folder mark that is not a whole line stays text", () => {
  assertEquals(
    withoutIds(markdownToPageBlocks(
      `Files live in {{trame:folder=~/reports}}.

{{trame:folder=}}

\`\`\`md
{{trame:folder=~/reports}}
\`\`\``,
    )),
    [
      { type: "text", text: "Files live in {{trame:folder=~/reports}}." },
      { type: "text", text: "{{trame:folder=}}" },
      { type: "text", text: "```md\n{{trame:folder=~/reports}}\n```" },
    ],
  );
});

Deno.test("folder blocks round-trip, the default view staying implicit", () => {
  const markdown =
    "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}\n";
  const blocks = markdownToPageBlocks(markdown);
  assertEquals(pageBlocksToMarkdown(blocks), markdown);
  assertEquals(
    pageBlocksToMarkdown([{ type: "folder", path: "~/reports", view: "list" }]),
    "{{trame:folder=~/reports}}\n",
  );
  // a half-configured block (the editor creates one with an empty path) has no line
  assertEquals(
    pageBlocksToMarkdown([{ type: "folder", path: "", view: "list" }]),
    "",
  );
});
