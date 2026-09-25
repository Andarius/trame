import { assertEquals } from "@std/assert";
import type { PageMeta } from "./api.ts";
import { recentRows } from "./recents.ts";

const page = (id: string, parent_id: string | null, at: string) =>
  ({ id, parent_id, updated_at: `2026-09-25T${at}Z` }) as PageMeta;

const shape = (pages: PageMeta[]) =>
  recentRows(pages).map((r) => r.kind === "page" ? r.page.id : `${r.parentId}[${r.pages.map((p) => p.id)}]`);

for (
  const { name, pages, want } of [
    {
      name: "same-parent burst folds into one row",
      pages: [page("a", "db", "10:00:00"), page("b", "db", "10:00:30"), page("c", "x", "09:00:00")],
      want: ["db[b,a]", "c"],
    },
    {
      name: "siblings outside the window stay apart",
      pages: [page("a", "db", "10:00:00"), page("b", "db", "10:05:00")],
      want: ["b", "a"],
    },
    {
      name: "root pages never group",
      pages: [page("a", null, "10:00:00"), page("b", null, "10:00:01")],
      want: ["b", "a"],
    },
    {
      name: "an interleaved edit splits the burst",
      pages: [page("a", "db", "10:00:00"), page("x", "y", "10:00:10"), page("b", "db", "10:00:20")],
      want: ["b", "x", "a"],
    },
  ]
) Deno.test(`recentRows: ${name}`, () => assertEquals(shape(pages), want));
