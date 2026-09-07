import { expect, test } from "@playwright/test";

for (const view of ["board", "list"]) {
  test(`tag clicks filter ${view} and survive reload`, async ({ page, request }) => {
    const suffix = crypto.randomUUID();
    const label = `filter:${suffix}`;
    const tag = await (await request.post("/api/tags", { data: { label } })).json();
    const story = await (await request.post("/api/pages", {
      data: { title: `Story ${suffix}`, kind: "story", tags: [tag.key] },
    })).json();
    for (const [name, extra] of [
      ["direct", { tags: [tag.key] }],
      ["inherited", { page_id: story.id }],
      ["unrelated", {}],
    ] as const) {
      expect((await request.post("/api/sessions", {
        data: { id: crypto.randomUUID(), title: `${name} ${suffix}`, no_event: true, ...extra },
      })).ok()).toBeTruthy();
    }
    await page.goto(`/?view=${view}`);
    const direct = page.getByText(`direct ${suffix}`, { exact: true });
    const inherited = page.getByText(`inherited ${suffix}`, { exact: true });
    const unrelated = page.getByText(`unrelated ${suffix}`, { exact: true });
    await expect(unrelated).toBeVisible();
    await inherited.locator("..").getByRole("button", { name: `Filter by tag ${label}` }).click();
    const filter = page.locator("header").getByTitle("Remove filter").filter({ hasText: suffix });
    await expect(filter).toBeVisible();
    await expect(direct).toBeVisible();
    await expect(inherited).toBeVisible();
    await expect(unrelated).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("session")).toBe(false);
    await page.reload();
    await expect(filter).toBeVisible();
    await expect(unrelated).toHaveCount(0);
    await filter.click();
    await expect(unrelated).toBeVisible();
    await direct.locator("..").getByRole("button", { name: `Filter by tag ${label}` }).click();
    await expect(filter).toBeVisible();
    await expect(unrelated).toHaveCount(0);
  });
}
