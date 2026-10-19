import { expect, test } from "bun:test";
import { markdownToPageBlocks, pageBlocksToMarkdown } from "../core/page-markdown.ts";

const withoutIds = (blocks: ReturnType<typeof markdownToPageBlocks>) =>
  blocks.map(({ id: _id, ...block }) => block);

test("Markdown becomes native headings and todos without losing other syntax", () => {
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

  expect(withoutIds(blocks)).toStrictEqual([
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
    expect(block.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
});

test("indented todos keep their nesting level", () => {
  expect(withoutIds(markdownToPageBlocks(
      "- [ ] parent\n  - [x] child\n\t- [ ] tab child\n      - [ ] deep",
    ))).toStrictEqual([
      { type: "todo", text: "parent", done: false },
      { type: "todo", text: "child", done: true, indent: 1 },
      { type: "todo", text: "tab child", done: false, indent: 1 },
      { type: "todo", text: "deep", done: false, indent: 3 },
    ]);
});

test("a non-matching leading H1 remains content", () => {
  expect(withoutIds(markdownToPageBlocks("# Different title\n\nBody", "Page title"))).toStrictEqual([
      { type: "heading", text: "Different title" },
      { type: "text", text: "Body" },
    ]);
});

test("pageBlocksToMarkdown round-trips through markdownToPageBlocks", () => {
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
  expect(withoutIds(markdownToPageBlocks(rendered))).toStrictEqual(withoutIds(blocks));
  // structural blocks are skipped, never serialized
  expect(pageBlocksToMarkdown([{ type: "subpage", page_id: "x" }, {
      type: "heading",
      text: "Goal",
    }])).toStrictEqual("## Goal\n");
  expect(pageBlocksToMarkdown([])).toStrictEqual("");
});

test("a lone {{trame:folder=...}} line becomes a folder block", () => {
  expect(withoutIds(markdownToPageBlocks(
      `## Artefacts

{{trame:folder=~/LLMS/Soren/compliance}}

{{trame:folder=./reports}} {{trame:view=gallery}}`,
    ))).toStrictEqual([
      { type: "heading", text: "Artefacts" },
      { type: "folder", path: "~/LLMS/Soren/compliance", view: "list" },
      { type: "folder", path: "./reports", view: "gallery" },
    ]);
});

test("a folder mark that is not a whole line stays text", () => {
  expect(withoutIds(markdownToPageBlocks(
      `Files live in {{trame:folder=~/reports}}.

{{trame:folder=}}

\`\`\`md
{{trame:folder=~/reports}}
\`\`\``,
    ))).toStrictEqual([
      { type: "text", text: "Files live in {{trame:folder=~/reports}}." },
      { type: "text", text: "{{trame:folder=}}" },
      { type: "text", text: "```md\n{{trame:folder=~/reports}}\n```" },
    ]);
});

test("folder blocks round-trip, the default view staying implicit", () => {
  const markdown =
    "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}\n";
  const blocks = markdownToPageBlocks(markdown);
  expect(pageBlocksToMarkdown(blocks)).toStrictEqual(markdown);
  expect(pageBlocksToMarkdown([{ type: "folder", path: "~/reports", view: "list" }])).toStrictEqual("{{trame:folder=~/reports}}\n");
  // a half-configured block (the editor creates one with an empty path) has no line
  expect(pageBlocksToMarkdown([{ type: "folder", path: "", view: "list" }])).toStrictEqual("");
});

test("a lone {{trame:embed=...}} line becomes an embed block", () => {
  expect(withoutIds(markdownToPageBlocks(
      `{{trame:embed=https://grafana.example.com/d/abc?kiosk}}

{{trame:embed=https://grafana.example.com/d/xyz}} {{trame:height=900}}

{{trame:embed=https://grafana.example.com/d/def}} {{trame:height=600}}

{{trame:embed=https://grafana.example.com/d/ghi}} {{trame:height=tall}}`,
    ))).toStrictEqual([
      { type: "embed", url: "https://grafana.example.com/d/abc?kiosk" },
      { type: "embed", url: "https://grafana.example.com/d/xyz", height: 900 },
      { type: "embed", url: "https://grafana.example.com/d/def" },
      { type: "embed", url: "https://grafana.example.com/d/ghi" },
    ]);
});

test("an embed mark that is not an https whole line stays text", () => {
  expect(withoutIds(markdownToPageBlocks(
      `See {{trame:embed=https://grafana.example.com/d/abc}}.

{{trame:embed=http://grafana.example.com/d/abc}}

{{trame:embed=javascript:alert(1)}}

{{trame:embed=https://a.example.com/x y}}

{{trame:embed=}}

\`\`\`md
{{trame:embed=https://grafana.example.com/d/abc}}
\`\`\``,
    ))).toStrictEqual([
      { type: "text", text: "See {{trame:embed=https://grafana.example.com/d/abc}}." },
      { type: "text", text: "{{trame:embed=http://grafana.example.com/d/abc}}" },
      { type: "text", text: "{{trame:embed=javascript:alert(1)}}" },
      { type: "text", text: "{{trame:embed=https://a.example.com/x y}}" },
      { type: "text", text: "{{trame:embed=}}" },
      { type: "text", text: "```md\n{{trame:embed=https://grafana.example.com/d/abc}}\n```" },
    ]);
});

test("embed blocks round-trip, the default height staying implicit", () => {
  const markdown =
    "## Metrics\n\n{{trame:embed=https://grafana.example.com/d/abc}} {{trame:height=900}}\n\n{{trame:embed=https://grafana.example.com/d/xyz}}\n";
  expect(pageBlocksToMarkdown(markdownToPageBlocks(markdown))).toStrictEqual(markdown);
  expect(pageBlocksToMarkdown([{ type: "embed", url: "https://a.example.com/", height: 600 }])).toStrictEqual("{{trame:embed=https://a.example.com/}}\n");
  // a half-configured block (the editor creates one with an empty url) has no line
  expect(pageBlocksToMarkdown([{ type: "embed", url: "" }])).toStrictEqual("");
});

test("a lone {{trame:db=...}} line becomes a database block and round-trips", () => {
  const markdown = "## Decision\n\n{{trame:db=db-1}}\n\nInline {{trame:db=db-2}} stays text.\n";
  const blocks = markdownToPageBlocks(`${markdown}\n{{trame:db= }}`);
  expect(withoutIds(blocks)).toStrictEqual([
    { type: "heading", text: "Decision" },
    { type: "database", db_id: "db-1" },
    { type: "text", text: "Inline {{trame:db=db-2}} stays text." },
    { type: "text", text: "{{trame:db= }}" },
  ]);
  expect(pageBlocksToMarkdown(blocks.slice(0, 3))).toStrictEqual(markdown);
});
