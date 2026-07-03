import { expect, test } from "@playwright/test";

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
  await expect(page.getByText("e2e report")).toBeVisible();
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
