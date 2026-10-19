import { expect, test } from "bun:test";
import { markdownToPageBlocks, type PageTextBlock } from "../core/page-markdown.ts";
import { mergePageBlocks } from "../core/page-merge.ts";

const text = (t: string, id: string): PageTextBlock => ({
  type: "text",
  text: t,
  id,
});

test("unchanged text keeps its id, changed text gets a fresh one", () => {
  const existing = [
    { type: "heading", text: "Checklist", id: "b1" },
    { type: "text", text: "Old paragraph.", id: "b2" },
  ];
  const next = markdownToPageBlocks("## Checklist\n\nNew paragraph.");
  const out = mergePageBlocks(existing, next) as PageTextBlock[];
  expect(out).toStrictEqual([
    { type: "heading", text: "Checklist", id: "b1" },
    { type: "text", text: "New paragraph.", id: next[1].id },
  ]);
});

test("reordered blocks follow their text", () => {
  const out = mergePageBlocks(
    [text("one", "b1"), text("two", "b2")],
    [text("two", "n1"), text("one", "n2")],
  ) as PageTextBlock[];
  expect(out.map((b) => b.id)).toStrictEqual(["b2", "b1"]);
});

test("duplicate texts pair up in document order", () => {
  const out = mergePageBlocks(
    [text("dup", "b1"), text("dup", "b2")],
    [text("dup", "n1"), text("dup", "n2"), text("dup", "n3")],
  ) as PageTextBlock[];
  expect(out.map((b) => b.id)).toStrictEqual(["b1", "b2", "n3"]);
});

test("matching trims text and ignores type; done/indent come from next", () => {
  const out = mergePageBlocks(
    [{ type: "text", text: "  Ship it ", id: "b1" }],
    [{ type: "todo", text: "Ship it", done: true, indent: 1, id: "n1" }],
  );
  expect(out).toStrictEqual([
    { type: "todo", text: "Ship it", done: true, indent: 1, id: "b1" },
  ]);
});

test("structural blocks re-anchor to the nearest surviving text block", () => {
  const existing = [
    { type: "database", db_id: "db-0" },
    { type: "heading", text: "A", id: "b1" },
    { type: "html", html: "<x>", id: "h1" },
    { type: "text", text: "gone", id: "b2" },
    { type: "subpage", page_id: "sp-1" },
  ];
  const next = [
    { type: "heading", text: "A", id: "n1" },
    { type: "text", text: "B", id: "n2" },
  ] satisfies PageTextBlock[];
  expect(mergePageBlocks(existing, next)).toStrictEqual([
    { type: "database", db_id: "db-0" },
    { type: "heading", text: "A", id: "b1" },
    { type: "html", html: "<x>", id: "h1" },
    { type: "subpage", page_id: "sp-1" },
    { type: "text", text: "B", id: "n2" },
  ]);
});

test("structural-only pages keep their blocks at the head", () => {
  expect(mergePageBlocks([{ type: "database", db_id: "db-1" }], [
      text("intro", "n1"),
    ])).toStrictEqual([{ type: "database", db_id: "db-1" }, text("intro", "n1")]);
});

test("id-less text blocks are dropped, unknown types preserved", () => {
  const out = mergePageBlocks(
    [{ type: "text", text: "legacy" }, { type: "mystery", foo: 1 }],
    [text("fresh", "n1")],
  );
  expect(out).toStrictEqual([{ type: "mystery", foo: 1 }, text("fresh", "n1")]);
});

test("empty existing content returns next unchanged", () => {
  const next = markdownToPageBlocks("# Title\n\nBody", "Title");
  expect(mergePageBlocks([], next)).toStrictEqual(next);
});

test("a rewrite that drops {{trame:...}} marks keeps the id and the dates", () => {
  const out = mergePageBlocks(
    [{
      type: "todo",
      text: "Ship it {{trame:created_at=2026-08-20}}",
      done: false,
      id: "b1",
    }],
    [{ type: "todo", text: "Ship it", done: true, id: "n1" }],
  );
  expect(out).toStrictEqual([{
    type: "todo",
    text: "Ship it {{trame:created_at=2026-08-20}}",
    done: true,
    id: "b1",
  }]);
});

test("a mark the rewrite states wins over the stored one", () => {
  const out = mergePageBlocks(
    [{
      type: "todo",
      text: "Ship it {{trame:created_at=2026-08-20}}",
      id: "b1",
    }],
    [{
      type: "todo",
      text: "Ship it {{trame:created_at=2026-01-01}}",
      id: "n1",
    }],
  ) as PageTextBlock[];
  expect(out[0].text).toStrictEqual("Ship it {{trame:created_at=2026-01-01}}");
  expect(out[0].id).toStrictEqual("b1");
});

const folder = (path: string, id: string) => ({
  type: "folder",
  path,
  view: "list",
  id,
});

test("a rewrite carrying the folder line reuses the block instead of adding one", () => {
  const out = mergePageBlocks(
    [
      { type: "heading", text: "Artefacts", id: "b1" },
      folder("~/reports", "b2"),
    ],
    markdownToPageBlocks(
      "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}",
    ),
  );
  expect(out).toStrictEqual([
    { type: "heading", text: "Artefacts", id: "b1" },
    { type: "folder", path: "~/reports", view: "gallery", id: "b2" },
  ]);
});

test("an edited path keeps the block's id and drops the stale folders", () => {
  const out = mergePageBlocks(
    [folder("~/old", "b1"), folder("~/gone", "b2")],
    markdownToPageBlocks("{{trame:folder=~/new}}"),
  );
  expect(out).toStrictEqual([{
    type: "folder",
    path: "~/new",
    view: "list",
    id: "b1",
  }]);
});

test("a rewrite with no folder line leaves the page's folders in place", () => {
  const out = mergePageBlocks(
    [
      { type: "heading", text: "Artefacts", id: "b1" },
      folder("~/reports", "b2"),
    ],
    markdownToPageBlocks("## Artefacts\n\nNothing to see."),
  );
  expect(out.length).toStrictEqual(3);
  expect(out[1]).toStrictEqual(folder("~/reports", "b2"));
});

test("a rewrite carrying an embed line keeps the block's id; other embeds drop", () => {
  const embed = (url: string, id: string) => ({ type: "embed", url, id });
  const out = mergePageBlocks(
    [embed("https://a.example.com/", "b1"), embed("https://gone.example.com/", "b2"), folder("~/r", "b3")],
    markdownToPageBlocks("{{trame:embed=https://a.example.com/}} {{trame:height=800}}"),
  );
  expect(out).toStrictEqual([
    folder("~/r", "b3"),
    { type: "embed", url: "https://a.example.com/", height: 800, id: "b1" },
  ]);
});

const database = (db_id: string, id: string) => ({ type: "database", db_id, id });

test("a rewrite moving a database line keeps its block id", () => {
  const out = mergePageBlocks(
    [
      { type: "heading", text: "Intro", id: "b1" },
      { type: "heading", text: "Decision", id: "b2" },
      database("db-1", "b3"),
      database("db-2", "b4"),
    ],
    markdownToPageBlocks("## Intro\n\n{{trame:db=db-2}}\n\n## Decision"),
  );
  expect(out).toStrictEqual([
    { type: "heading", text: "Intro", id: "b1" },
    database("db-2", "b4"),
    { type: "heading", text: "Decision", id: "b2" },
  ]);
});

test("a rewrite with only a folder line leaves the page's databases in place", () => {
  const out = mergePageBlocks(
    [{ type: "heading", text: "Data", id: "b1" }, database("db-1", "b2")],
    markdownToPageBlocks("## Data\n\n{{trame:folder=~/reports}}"),
  );
  expect(out[1]).toStrictEqual(database("db-1", "b2"));
  expect(out.length).toStrictEqual(3);
});
