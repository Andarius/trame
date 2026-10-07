import { expect, test } from "@playwright/test";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
};

test("a due todo shows its pill and the DUE section; the picker moves and clears the date", async ({ page, request }) => {
  const title = `rotate the reader keys ${crypto.randomUUID()}`;
  const p = await (await request.post("/api/pages", {
    data: {
      title: "Due e2e",
      content: [{ id: crypto.randomUUID(), type: "todo", text: `${title} {{trame:due=${day(-2)}}}`, done: false }],
    },
  })).json() as { id: string };

  await page.goto(`/?view=page&page=${p.id}`);
  const row = page.locator("div.group", { hasText: title }).last();
  await expect(row.getByText("⚑ 2 days late")).toBeVisible();
  const due = page.getByRole("navigation", { name: "Due todos" });
  await expect(due.getByText(title)).toBeVisible();
  // the sidebar row opens the todo's page
  await page.goto("/?view=list");
  await due.getByText(title).click();
  await expect(page).toHaveURL(new RegExp(`page=${p.id}`));

  await row.hover();
  await row.getByTitle("Due date").click();
  await page.getByRole("button", { name: "Tomorrow" }).click();
  await expect(row.getByText("⚑ tomorrow")).toBeVisible();
  await expect.poll(async () => {
    const saved = await (await request.get(`/api/pages/${p.id}`)).json() as { content: { text: string }[] };
    return saved.content[0].text;
  }).toBe(`${title} {{trame:due=${day(1)}}}`);

  // the pill itself reopens the picker
  await row.getByRole("button", { name: "⚑ tomorrow" }).click();
  await page.getByRole("button", { name: "Clear due date" }).click();
  await expect(row.getByText(/⚑ \d|⚑ to/)).toHaveCount(0);
  // an undated todo offers the picker on hover
  await row.hover();
  await row.getByRole("button", { name: "⚑ due" }).click();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(row.getByText("⚑ today")).toBeVisible();
});

test("a due todo on a card's spec page opens the card from the sidebar", async ({ page, request }) => {
  const id = crypto.randomUUID();
  const title = `bump asyncpg ${id}`;
  const second = crypto.randomUUID();
  expect((await request.post("/api/sessions", { data: { id, title: `Rollout ${id}`, no_event: true } })).ok()).toBeTruthy();
  const { page_id } = await (await request.post(`/api/sessions/${id}/specs-page`)).json() as { page_id: string };
  await request.post(`/api/pages/${page_id}`, {
    data: {
      content: [
        { id: crypto.randomUUID(), type: "todo", text: `${title} {{trame:due=${day(2)}}}`, done: false },
        { id: second, type: "todo", text: `recheck stubs ${id} {{trame:due=${day(4)}}}`, done: false },
      ],
    },
  });

  await page.goto("/?view=list");
  const due = page.getByRole("navigation", { name: "Due todos" });
  await due.getByText(title).click();
  await expect(page).toHaveURL(new RegExp(`view=card&card=${id}`));
  // the card is already open: the second row still answers, by ringing its todo
  await due.getByText(`recheck stubs ${id}`).click();
  await expect(page.locator(`[data-block-id="${second}"]`)).toHaveClass(/ring-copper/);
  await page.locator(`[data-block-id="${second}"]`).hover();
});
