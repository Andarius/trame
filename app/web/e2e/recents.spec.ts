import { expect, type Page, test } from "@playwright/test";

// The RECENTLY MODIFIED section: the tree sorted by pages.updated_at, 5 rows,
// extendable to 20 by a fold that persists through `trame:expanded`.
test.describe.configure({ mode: "serial" });

const PREFIX = "Recents e2e";
const NEWEST = `${PREFIX} 6`;

const rows = (page: Page) =>
  page.getByRole("navigation", { name: "Recently modified" }).getByRole("button");

// six of our own, so "more than a screenful" holds whatever else the backend carries
test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string }[];
  for (const p of pages.filter((x) => x.title.startsWith(PREFIX))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
  for (let i = 1; i <= 6; i++) {
    await request.post("/api/stories", { data: { title: `${PREFIX} ${i}`, brief: "" } });
  }
});

test("the page touched last tops the section", async ({ page }) => {
  await page.goto("/");
  await expect(rows(page).first()).toContainText(NEWEST);
  await expect(rows(page)).toHaveCount(5);
});

test("Show more extends the list, and the fold survives a reload", async ({ page }) => {
  await page.goto("/");
  const aside = page.locator("aside");
  await aside.getByRole("button", { name: "Show more" }).click();
  await expect(aside.getByRole("button", { name: "Show less" })).toBeVisible();
  const extended = await rows(page).count();
  expect(extended).toBeGreaterThan(5);
  expect(extended).toBeLessThanOrEqual(20);

  await page.reload();
  await expect(aside.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(rows(page)).toHaveCount(extended);
});
