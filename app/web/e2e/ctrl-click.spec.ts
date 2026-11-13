import { expect, test } from "@playwright/test";

test("ctrl+click on a sidebar page opens a new tab; on a card, a workspace", async ({ page, context, request }) => {
  const id = crypto.randomUUID();
  expect((await request.post("/api/sessions", { data: { id, title: `Ctrl card ${id}`, no_event: true } })).ok()).toBeTruthy();
  const p = await (await request.post("/api/pages", { data: { title: `Ctrl page ${id}`, content: [] } })).json() as { id: string };

  await page.goto("/?view=list");
  const before = page.url();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByText(`Ctrl page ${id}`).first().click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await expect(tab).toHaveURL(new RegExp(`page=${p.id}`));
  expect(page.url()).toBe(before);

  // a card opens in its own workspace on the rail, in this window; Home keeps the board
  await page.goto("/?view=board");
  await page.getByText(`Ctrl card ${id}`).first().click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`card=${id}`));
  const views = page.getByRole("navigation", { name: "Views" });
  await expect(views.getByRole("button", { name: `Ctrl card ${id}` })).toHaveAttribute("aria-current", "true");
  await views.getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL(/view=board|^[^?]*$/);
});
