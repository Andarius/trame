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
    await expect(tags).toBeVisible();
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
    // removal lives in the chip's popover
    await tags.getByTitle("Colour or remove this tag").first().click();
    await page.getByText("✕ Remove tag").click();
    await expect.poll(async () =>
      (await (await request.get(`/api/sessions/${id}`)).json()).tags
    ).toEqual([`review-${id}`]);
    await tags.getByTitle("Colour or remove this tag").click();
    await page.getByText("✕ Remove tag").click();
    await expect.poll(async () =>
      (await (await request.get(`/api/sessions/${id}`)).json()).tags
    ).toEqual([]);
    await page.reload();
    await expect(tags.getByTitle("Colour or remove this tag")).toHaveCount(0);
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

test("the tag picker takes Enter for the first match and arrows to move", async ({ page, request }) => {
  const id = crypto.randomUUID();
  const [a, b] = [`kbd-alpha:${id.slice(0, 8)}`, `kbd-beta:${id.slice(0, 8)}`];
  const keys = [] as string[];
  for (const label of [a, b]) keys.push(((await (await request.post("/api/tags", { data: { label } })).json()) as { key: string }).key);
  expect((await request.post("/api/sessions", { data: { id, title: `Kbd tags ${id}`, no_event: true } })).ok()).toBeTruthy();
  const tagsOf = async () => ((await (await request.get(`/api/sessions/${id}`)).json()) as { tags: string[] }).tags;

  await page.goto(`/?session=${id}`);
  const tags = page.getByRole("group", { name: "Session tags" });
  // Enter takes the first match
  await tags.getByTitle("add a tag").click();
  await tags.getByPlaceholder("Find or create a tag…").fill(`kbd-alpha:${id.slice(0, 8)}`);
  await page.keyboard.press("Enter");
  await expect.poll(tagsOf).toEqual([keys[0]]);
  // arrows move the highlight; Enter takes it, here the "Create" row after the one match
  await tags.getByTitle("add a tag").click();
  await tags.getByPlaceholder("Find or create a tag…").fill(`kbd-be`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(tagsOf).toEqual([keys[0], "kbd-be"]);
  await tags.getByTitle("add a tag").click();
  await tags.getByPlaceholder("Find or create a tag…").fill(`kbd-be`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(tagsOf).toEqual([keys[0], "kbd-be", keys[1]]);
});
