import { expect, test } from "@playwright/test";

// Serialized flow against one fresh backend: create → drawer edit → move → views.
test.describe.configure({ mode: "serial" });

test("board renders the empty shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Trame", { exact: true })).toBeVisible();
  for (const col of ["Active", "Paused", "Blocked", "Done"]) {
    await expect(page.getByText(col, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/Local only · e2e/)).toBeVisible();
});

test("create a session via the modal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New session/ }).click();
  await page.getByPlaceholder("repo — short topic").fill("e2e — first session");
  await page.getByPlaceholder("next step (imperative, one line)").fill("verify it lands in Active");
  await page.getByRole("button", { name: /Create session/ }).click();
  await expect(page.getByText("e2e — first session")).toBeVisible();
  await expect(page.getByText("→ verify it lands in Active")).toBeVisible();
});

test("drawer opens on card click and moves the session", async ({ page }) => {
  await page.goto("/");
  await page.getByText("e2e — first session").click();
  await expect(page.getByText("SESSION", { exact: true })).toBeVisible();
  // status pill auto-commits
  await page.getByRole("button", { name: "Paused" }).click();
  await page.keyboard.press("Escape");
  // card refetches into the Paused column
  await expect(page.getByText("e2e — first session")).toBeVisible();
});

test("worklog entry can be added from the drawer", async ({ page }) => {
  await page.goto("/");
  await page.getByText("e2e — first session").click();
  const log = page.getByPlaceholder(/what happened/);
  await log.fill("did the e2e thing");
  await log.press("Enter");
  await expect(page.getByText("did the e2e thing")).toBeVisible();
});

test("list view shows the session", async ({ page }) => {
  await page.goto("/?view=list");
  await expect(page.getByText("SESSION", { exact: true })).toBeVisible();
  await expect(page.getByText("e2e — first session")).toBeVisible();
});

test("a project can be created from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New project/ }).click();
  // New project creates an empty top-level Project page and opens it — name it via the title field
  await page.getByPlaceholder("Untitled").fill("E2E Project");
  await page.getByPlaceholder("Untitled").blur();
  // it appears in the sidebar PROJECTS tree
  await expect(page.locator("aside").getByRole("button", { name: /E2E Project/ })).toBeVisible();
});

test("group by Story renders swimlanes; the control reflects the choice", async ({ page }) => {
  await page.goto("/?view=board&group=story");
  // the icon menu button shows the active dimension
  await expect(page.getByTitle("Group the board")).toContainText("Story");
  await expect(page.getByText("— No story")).toBeVisible();
});

test("the Group menu switches to Project grouping", async ({ page }) => {
  await page.goto("/?view=board");
  await page.getByTitle("Group the board").click();
  await page.getByRole("button", { name: /◎ Project/ }).click();
  // now grouped by Project — the control and the catch-all lane both say Project
  await expect(page.getByTitle("Group the board")).toContainText("Project");
  await expect(page.getByText("— No project")).toBeVisible();
});

test("a Project page creates a Story child via New story", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /E2E Project/ }).click();
  await page.getByRole("button", { name: /New story/ }).click();
  // wait for the NEW page's view before typing — the parent's title field shares the
  // placeholder, so filling too early renames the parent instead (a real race)
  await expect(page.getByPlaceholder("Untitled")).toHaveValue("");
  await page.getByPlaceholder("Untitled").fill("E2E Story");
  await page.keyboard.press("Enter");
  // it nests under the project as a Story (◇), reachable in the sidebar tree
  const node = page.locator("aside").getByRole("button", { name: /E2E Story/ }).first();
  await expect(node).toBeVisible();
  await expect(node).toContainText("◇");
});

test("a Project's color swatch tints its sidebar glyph", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /E2E Project/ }).first().click();
  await page.getByTitle("project color").click();
  // pick a specific palette color (red) and confirm it lands on the sidebar glyph
  await page.locator('button[style*="rgb(224, 108, 117)"], button[style*="#e06c75"]').first().click();
  const glyph = page.locator("aside").getByRole("button", { name: /E2E Project/ }).first().locator("span").first();
  await expect(glyph).toHaveCSS("color", "rgb(224, 108, 117)");
});

test("the DATABASES section header is always visible", async ({ page }) => {
  await page.goto("/");
  // even with no databases, the header + New database chip live under their own section
  await expect(page.locator("aside").getByText("DATABASES", { exact: true })).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: /New database/ })).toBeVisible();
});
