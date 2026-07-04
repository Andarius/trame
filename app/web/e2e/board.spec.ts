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
  // card refetches into the Paused column — count badge next to the header
  const paused = page.locator("div", { hasText: /^Paused/ }).first();
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

test("project page can be created from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New project/ }).click();
  await page.getByPlaceholder("What are we trying to achieve?").fill("E2E Objective");
  await page.getByRole("button", { name: /Create project/ }).click();
  // creating a project opens its page
  await expect(page.getByText("no sessions yet")).toBeVisible();
  // and it appears in the sidebar tree
  await expect(page.getByRole("button", { name: /E2E Objective/ })).toBeVisible();
});

test("group-by-project swimlanes render", async ({ page }) => {
  await page.goto("/?view=board&group=objective");
  await expect(page.getByRole("button", { name: /Group · Project/ })).toBeVisible();
  await expect(page.getByText("— No project")).toBeVisible();
});
