import { expect, test } from "@playwright/test";

// Serialized flow: project page → blocks → sub-page → session link → delete subtree.
test.describe.configure({ mode: "serial" });

// serial + retries re-run the WHOLE chain on the same backend — wipe our fixtures
// first so a retry starts from scratch instead of stacking duplicates
test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string }[];
  for (const p of pages.filter((x) => ["Pages Project", "Nested notes"].includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
  const board = await (await request.get("/api/board")).json() as { sessions: { id: string; title: string }[] };
  for (const s of board.sessions.filter((x) => x.title === "pages e2e session")) {
    await request.post(`/api/sessions/${s.id}/delete`, { data: {} });
  }
});

test("a story page shows its brief, blocks and sessions", async ({ page, request }) => {
  await request.post("/api/stories", {
    data: { title: "Pages Project", brief: "the pages e2e brief" },
  });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await expect(page.getByPlaceholder(/add the brief/)).toHaveValue("the pages e2e brief");
  await expect(page.getByText("no sessions yet")).toBeVisible();

  // block editor: type, autosave, survive a reload
  const editor = page.getByPlaceholder(/type \/ for blocks/);
  await editor.fill("first block of the page body");
  await page.waitForTimeout(1200); // > the 800ms autosave debounce
  await page.reload();
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await expect(page.getByPlaceholder(/type \/ for blocks/)).toHaveValue("first block of the page body");
});

test("sub-page nests under the project", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await page.getByRole("button", { name: /New sub-page/ }).click();
  // wait for the NEW page's view: the parent's title input has the same placeholder,
  // so filling before the view swaps would rename the parent instead (real race)
  await expect(page.getByPlaceholder("Untitled")).toHaveValue("");
  await page.getByPlaceholder("Untitled").fill("Nested notes");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Pages Project" }).first()).toBeVisible(); // breadcrumb
  // the tree auto-expands the ancestors of the open page
  await expect(page.getByRole("button", { name: /Nested notes/ }).first()).toBeVisible();
});

test("session linked to the project shows up with progress", async ({ page, request }) => {
  await request.post("/api/sessions", {
    data: { title: "pages e2e session", story: "Pages Project", no_event: true },
  });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await expect(page.getByText("pages e2e session").first()).toBeVisible();
  await expect(page.getByText("0 / 1 done").first()).toBeVisible();
});

test("deleting the project removes the subtree from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click(); // confirm dialog
  // scope to the sidebar (the board card's project chip also matches); count-based
  // because a draggable story row carries role=button on the row div too
  await expect(page.locator("aside").getByRole("button", { name: /Pages Project/ })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("button", { name: /Nested notes/ })).toHaveCount(0);
});

test("attaching a session to a plain page promotes it to a project", async ({ page, request }) => {
  // plain page, no session yet → sits under UNFILED
  await request.post("/api/pages", { data: { title: "Scratch notes", kind: "page" } });
  // attach by title (the CLI path) — must reuse the page, not mint a duplicate project
  await request.post("/api/sessions", {
    data: { title: "promo e2e session", story: "Scratch notes", no_event: true },
  });
  const pages = await (await request.get("/api/pages")).json();
  const hits = pages.filter((p: { title: string }) => p.title === "Scratch notes");
  expect(hits).toHaveLength(1); // title-collision regression
  expect(hits[0].kind).toBe("story");
  await page.goto("/");
  // promoted page renders as a Story (◇ glyph) and lists its session
  const nav = page.locator("aside").getByRole("button", { name: /Scratch notes/ }).first();
  await expect(nav).toBeVisible();
  await expect(nav).toContainText("◇");
  await nav.click();
  await expect(page.getByText("promo e2e session").first()).toBeVisible();
  // grouped board gains a lane for it
  await page.goto("/?view=board&group=story");
  await expect(page.getByRole("main").getByText("Scratch notes", { exact: true })).toBeVisible();
});

test("drawer picker offers plain pages and promotes on pick", async ({ page, request }) => {
  await request.post("/api/pages", { data: { title: "Loose notes", kind: "page" } });
  await request.post("/api/sessions", { data: { title: "drawer promo session", no_event: true } });
  await page.goto("/");
  await page.getByText("drawer promo session").click();
  // the project row Select lists the plain page with the □ glyph
  await page.getByRole("button", { name: /^none/ }).last().click(); // Project trigger (Client is the first "none ▾")
  await page.getByRole("button", { name: "□ Loose notes" }).last().click(); // sidebar shows the page too
  await page.keyboard.press("Escape");
  // picking promoted it: sidebar shows it as a Story (◇)
  const nav = page.locator("aside").getByRole("button", { name: /Loose notes/ }).first();
  await expect(nav).toContainText("◇");
});

test("the Story picker lists each story once as ◇ (no ◎/□ duplicates)", async ({ page, request }) => {
  // a story with a distinctive title, plus a session to drive the drawer
  await request.post("/api/sessions", { data: { title: "picker probe session", story: "Picker Story", no_event: true } });
  await page.goto("/");
  await page.getByText("picker probe session").click();
  await page.getByRole("button", { name: /^◇ Picker Story|^none/ }).last().click(); // open the Story select
  // stories are ◇ only — regression guard for the old bug where each showed twice (◎ and □)
  await expect(page.getByRole("button", { name: "◇ Picker Story" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "◎ Picker Story" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "□ Picker Story" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});
