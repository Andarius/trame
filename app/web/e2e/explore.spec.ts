import { type APIRequestContext, expect, test } from "@playwright/test";

test("explore shows isolated empty state", async ({ page }) => {
  await page.goto("/?view=explore");
  // settings are sandboxed → no folders configured, no published reports
  await expect(page.getByText(/No indexed files/)).toBeVisible();
  await expect(page.getByText(/No published reports yet/)).toBeVisible();
});

test("published report renders in the viewer", async ({ page, request }) => {
  await request.post("/api/reports", {
    data: {
      title: "e2e report",
      html: "<html><body><h1>hello from e2e</h1></body></html>",
      client: "E2E Client",
    },
  });
  await page.goto("/?view=explore");
  // the title appears in both the list and the viewer header — assert the list entry
  await expect(page.getByRole("button", { name: /e2e report/ })).toBeVisible();
  // rendered inside the sandboxed iframe
  await expect(page.frameLocator("iframe").getByText("hello from e2e")).toBeVisible();
});

test("settings modal opens from the gear", async ({ page }) => {
  await page.goto("/?view=explore");
  await page.getByTitle("Settings").click();
  await expect(page.getByText("Explore — report folders")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Explore — report folders")).not.toBeVisible();
});

const publish = async (request: APIRequestContext, title: string) => {
  const res = await request.post("/api/reports", { data: { title, html: `<p>${title}</p>` } });
  return ((await res.json()) as { id: string }).id;
};

test("starring a report pins it in the Starred section", async ({ page, request }) => {
  const id = await publish(request, "starrable report");
  await page.goto("/?view=explore");
  const row = page.locator(`[data-key="db:${id}"]`);
  await expect(row).toBeVisible();
  await row.locator("+ button").click(); // ★ sits next to the row button
  await expect(page.getByText("STARRED")).toBeVisible();
  await expect(page.getByRole("button", { name: /starrable report/ })).toHaveCount(2); // starred copy + list
  await row.locator("+ button").click();
  await expect(page.getByText("STARRED")).toHaveCount(0);
});

test("unpublishes several reports at once", async ({ page, request }) => {
  const a = await publish(request, "bulk one");
  const b = await publish(request, "bulk two");
  await page.goto("/?view=explore");
  await page.locator(`[data-key="db:${a}"]`).click();
  await page.locator(`[data-key="db:${b}"]`).click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("button", { name: /Unpublish 2/ }).click();
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(page.locator(`[data-key="db:${a}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-key="db:${b}"]`)).toHaveCount(0);
});
