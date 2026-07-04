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

test("project page shows story, blocks and sessions", async ({ page, request }) => {
  await request.post("/api/objectives", {
    data: { title: "Pages Project", story: "the pages e2e story", client: "E2E Client" },
  });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Pages Project/ }).first().click();
  await expect(page.getByPlaceholder(/add the story/)).toHaveValue("the pages e2e story");
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
    data: { title: "pages e2e session", objective: "Pages Project", no_event: true },
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
  // scope to the sidebar: the board card's project chip also matches /Pages Project/,
  // and a 2-element strict violation throws immediately instead of polling to zero
  await expect(page.locator("aside").getByRole("button", { name: /Pages Project/ })).not.toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: /Nested notes/ })).not.toBeVisible();
});
