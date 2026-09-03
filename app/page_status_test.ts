import { assertEquals } from "@std/assert";
import { isPageStatus, PAGE_STATUSES } from "./page-status.ts";

Deno.test("isPageStatus accepts every status the editor offers", () => {
  for (const s of PAGE_STATUSES) assertEquals(isPageStatus(s.value), true);
});

Deno.test("isPageStatus rejects anything the tree cannot render", () => {
  // Not pedantry: the column is free text, so an unknown value stores happily
  // and then matches no rule — the page looks normal and quietly escapes every
  // behaviour its status was meant to trigger.
  for (const s of ["", "Done", "todo", "in_progress", null, undefined, 3]) {
    assertEquals(isPageStatus(s), false, `${String(s)} must not pass`);
  }
});

Deno.test("the keys the tree branches on are still in the list", () => {
  // App.tsx dims `done` and folds `archived`, Drawer/modals filter `archived`
  // out of the pickers, Board tags its lane. Renaming either value here without
  // touching those would silently switch the behaviour off.
  const keys = PAGE_STATUSES.map((s) => s.value);
  assertEquals(keys.includes("done"), true);
  assertEquals(keys.includes("archived"), true);
});
