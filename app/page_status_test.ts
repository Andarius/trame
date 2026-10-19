import { expect, test } from "bun:test";
import { isPageStatus, PAGE_STATUSES } from "../core/page-status.ts";

test("isPageStatus accepts every status the editor offers", () => {
  for (const s of PAGE_STATUSES) expect(isPageStatus(s.value)).toStrictEqual(true);
});

test("isPageStatus rejects anything the tree cannot render", () => {
  // Not pedantry: the column is free text, so an unknown value stores happily
  // and then matches no rule — the page looks normal and quietly escapes every
  // behaviour its status was meant to trigger.
  for (const s of ["", "Archived", "todo", "in_progress", null, undefined, 3]) {
    expect(isPageStatus(s), `${String(s)} must not pass`).toStrictEqual(false);
  }
});

test("`done` is not a page status — that axis belongs to sessions", () => {
  // Removed after being set zero times in 110 pages while sessions used it 66.
  // Pinned so it cannot drift back in without someone reading why.
  expect(isPageStatus("done")).toStrictEqual(false);
});

test("the key the tree branches on is still in the list", () => {
  // App.tsx folds `archived`, Drawer/modals filter it out of the pickers, Board
  // tags its lane. Renaming it here without touching those would silently
  // switch every one of those behaviours off.
  expect(PAGE_STATUSES.map((s) => s.value).includes("archived")).toStrictEqual(true);
});
