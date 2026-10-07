import { expect, test } from "@playwright/test";

test("ctrl+click on a card row or a sidebar page opens it in a new tab and stays put", async ({ page, context, request }) => {
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

  await page.goto("/?view=board");
  const [cardTab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByText(`Ctrl card ${id}`).first().click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await expect(cardTab).toHaveURL(new RegExp(`card=${id}`));
  await expect(page).toHaveURL(/view=board|^[^?]*$/);
});
