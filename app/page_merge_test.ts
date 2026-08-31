import { assertEquals } from "@std/assert";
import { markdownToPageBlocks, type PageTextBlock } from "./page-markdown.ts";
import { mergePageBlocks } from "./page-merge.ts";

const text = (t: string, id: string): PageTextBlock => ({
  type: "text",
  text: t,
  id,
});

Deno.test("unchanged text keeps its id, changed text gets a fresh one", () => {
  const existing = [
    { type: "heading", text: "Checklist", id: "b1" },
    { type: "text", text: "Old paragraph.", id: "b2" },
  ];
  const next = markdownToPageBlocks("## Checklist\n\nNew paragraph.");
  const out = mergePageBlocks(existing, next) as PageTextBlock[];
  assertEquals(out, [
    { type: "heading", text: "Checklist", id: "b1" },
    { type: "text", text: "New paragraph.", id: next[1].id },
  ]);
});

Deno.test("reordered blocks follow their text", () => {
  const out = mergePageBlocks(
    [text("one", "b1"), text("two", "b2")],
    [text("two", "n1"), text("one", "n2")],
  ) as PageTextBlock[];
  assertEquals(out.map((b) => b.id), ["b2", "b1"]);
});

Deno.test("duplicate texts pair up in document order", () => {
  const out = mergePageBlocks(
    [text("dup", "b1"), text("dup", "b2")],
    [text("dup", "n1"), text("dup", "n2"), text("dup", "n3")],
  ) as PageTextBlock[];
  assertEquals(out.map((b) => b.id), ["b1", "b2", "n3"]);
});

Deno.test("matching trims text and ignores type; done/indent come from next", () => {
  const out = mergePageBlocks(
    [{ type: "text", text: "  Ship it ", id: "b1" }],
    [{ type: "todo", text: "Ship it", done: true, indent: 1, id: "n1" }],
  );
  assertEquals(out, [
    { type: "todo", text: "Ship it", done: true, indent: 1, id: "b1" },
  ]);
});

Deno.test("structural blocks re-anchor to the nearest surviving text block", () => {
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
  assertEquals(mergePageBlocks(existing, next), [
    { type: "database", db_id: "db-0" },
    { type: "heading", text: "A", id: "b1" },
    { type: "html", html: "<x>", id: "h1" },
    { type: "subpage", page_id: "sp-1" },
    { type: "text", text: "B", id: "n2" },
  ]);
});

Deno.test("structural-only pages keep their blocks at the head", () => {
  assertEquals(
    mergePageBlocks([{ type: "database", db_id: "db-1" }], [
      text("intro", "n1"),
    ]),
    [{ type: "database", db_id: "db-1" }, text("intro", "n1")],
  );
});

Deno.test("id-less text blocks are dropped, unknown types preserved", () => {
  const out = mergePageBlocks(
    [{ type: "text", text: "legacy" }, { type: "mystery", foo: 1 }],
    [text("fresh", "n1")],
  );
  assertEquals(out, [{ type: "mystery", foo: 1 }, text("fresh", "n1")]);
});

Deno.test("empty existing content returns next unchanged", () => {
  const next = markdownToPageBlocks("# Title\n\nBody", "Title");
  assertEquals(mergePageBlocks([], next), next);
});

Deno.test("a rewrite that drops {{trame:...}} marks keeps the id and the dates", () => {
  const out = mergePageBlocks(
    [{
      type: "todo",
      text: "Ship it {{trame:created_at=2026-08-20}}",
      done: false,
      id: "b1",
    }],
    [{ type: "todo", text: "Ship it", done: true, id: "n1" }],
  );
  assertEquals(out, [{
    type: "todo",
    text: "Ship it {{trame:created_at=2026-08-20}}",
    done: true,
    id: "b1",
  }]);
});

Deno.test("a mark the rewrite states wins over the stored one", () => {
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
  assertEquals(out[0].text, "Ship it {{trame:created_at=2026-01-01}}");
  assertEquals(out[0].id, "b1");
});

const folder = (path: string, id: string) => ({
  type: "folder",
  path,
  view: "list",
  id,
});

Deno.test("a rewrite carrying the folder line reuses the block instead of adding one", () => {
  const out = mergePageBlocks(
    [
      { type: "heading", text: "Artefacts", id: "b1" },
      folder("~/reports", "b2"),
    ],
    markdownToPageBlocks(
      "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}",
    ),
  );
  assertEquals(out, [
    { type: "heading", text: "Artefacts", id: "b1" },
    { type: "folder", path: "~/reports", view: "gallery", id: "b2" },
  ]);
});

Deno.test("an edited path keeps the block's id and drops the stale folders", () => {
  const out = mergePageBlocks(
    [folder("~/old", "b1"), folder("~/gone", "b2")],
    markdownToPageBlocks("{{trame:folder=~/new}}"),
  );
  assertEquals(out, [{
    type: "folder",
    path: "~/new",
    view: "list",
    id: "b1",
  }]);
});

Deno.test("a rewrite with no folder line leaves the page's folders in place", () => {
  const out = mergePageBlocks(
    [
      { type: "heading", text: "Artefacts", id: "b1" },
      folder("~/reports", "b2"),
    ],
    markdownToPageBlocks("## Artefacts\n\nNothing to see."),
  );
  assertEquals(out.length, 3);
  assertEquals(out[1], folder("~/reports", "b2"));
});
