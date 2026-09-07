import { expect, test } from "@playwright/test";

for (const full of [false, true]) {
  test(`session tags are editable in ${full ? "full screen" : "side panel"}`, async ({ page, request }) => {
    const id = crypto.randomUUID();
    const title = `Tagged session ${id}`;
    const priority = await (await request.post("/api/tags", {
      data: { label: "priority:P1" },
    })).json() as { key: string };
    const story = await (await request.post("/api/pages", {
      data: { title: `Story ${id}`, kind: "story", tags: ["story-only"] },
    })).json() as { id: string };
    expect((await request.post("/api/sessions", {
      data: { id, title, page_id: story.id, no_event: true },
    })).ok()).toBeTruthy();

    await page.goto(`/?session=${id}${full ? "&full=1" : ""}`);
    const tags = page.getByRole("group", { name: "Session tags" });
    await expect(page.locator('textarea + [aria-label="Session tags"]')).toBeVisible();
    await tags.getByTitle("add a tag").click();
    await tags.getByRole("button", { name: "priority:P1", exact: true }).click();
    await expect(tags.getByText("P1", { exact: true })).toBeVisible();

    const extraLabel = `review:${id}`;
    await tags.getByTitle("add a tag").click();
    await tags.getByPlaceholder("Find or create a tag…").fill(extraLabel);
    await tags.getByRole("button", { name: `＋ Create “${extraLabel}”`, exact: true }).click();
    await expect.poll(async () => {
      const session = await (await request.get(`/api/sessions/${id}`)).json();
      return session.tags;
    }).toEqual([priority.key, `review-${id}`]);

    await page.getByTitle("close (esc)").click();
    const card = page.getByText(title, { exact: true }).locator("..");
    await expect(card.getByText(id, { exact: true })).toBeVisible();
    await page.getByText(title, { exact: true }).click();
    await page.reload();
    await expect(tags.getByText("P1", { exact: true })).toBeVisible();
    await expect(tags.getByText(id, { exact: true })).toBeVisible();
    expect((await (await request.get(`/api/pages/${story.id}`)).json()).tags).toEqual(["story-only"]);

    for (const view of ["board", "list"]) {
      await page.goto(`/?view=${view}`);
      const row = page.getByText(title, { exact: true }).locator("..");
      await expect(row.getByText("P1", { exact: true })).toBeVisible();
      await expect(row.getByText(id, { exact: true })).toBeVisible();
    }

    await page.goto(`/?session=${id}${full ? "&full=1" : ""}`);
    await tags.getByTitle("Remove", { exact: true }).first().click();
    await expect.poll(async () =>
      (await (await request.get(`/api/sessions/${id}`)).json()).tags
    ).toEqual([`review-${id}`]);
    await tags.getByTitle("Remove", { exact: true }).click();
    await expect.poll(async () =>
      (await (await request.get(`/api/sessions/${id}`)).json()).tags
    ).toEqual([]);
    await page.reload();
    await expect(tags.getByTitle("Remove", { exact: true })).toHaveCount(0);
  });
}

test("invalid session tags return 400 without changing the card", async ({ request }) => {
  const id = crypto.randomUUID();
  await request.post("/api/sessions", {
    data: { id, title: "Keep me", tags: ["priority-p1"], no_event: true },
  });
  const response = await request.post("/api/sessions", {
    data: { id, title: "Invalid", tags: null, no_event: true },
  });
  expect(response.status()).toBe(400);
  const session = await (await request.get(`/api/sessions/${id}`)).json();
  expect(session.title).toBe("Keep me");
  expect(session.tags).toEqual(["priority-p1"]);
});
