import { expect, test } from "@playwright/test";

test("a card assigned in Cockpit shows its assigner's face on the board and in the card view", async ({ page, request }) => {
  const id = crypto.randomUUID();
  const title = `GEN-77 — fix the picker ${id}`;
  expect((await request.post("/api/sessions", { data: { id, title, no_event: true } })).ok()).toBeTruthy();
  const avatar = "data:image/svg+xml;utf8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="teal"/></svg>');
  await page.route("**/api/plugins/cockpit/assigners", (r) =>
    r.fulfill({ json: { [id]: { name: "Ana Lima", avatar } } }));

  await page.goto("/?view=board");
  const tile = page.locator("div.rounded-lg", { hasText: title }).first();
  await expect(tile.getByTitle("Assigned by Ana Lima in Cockpit")).toBeVisible();

  await page.goto(`/?view=card&card=${id}`);
  await expect(page.getByText("Assigned by", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Ana Lima" })).toBeVisible();
});
