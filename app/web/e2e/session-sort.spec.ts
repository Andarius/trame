import { expect, test } from "@playwright/test";

for (const view of ["board", "list"]) {
  test(`multiple sort fields order ${view} by numeric priority then title`, async ({ page, request }) => {
    const suffix = crypto.randomUUID();
    const group = `sort-${suffix}`;
    const story = await (await request.post("/api/pages", {
      data: { title: `Priority story ${suffix}`, kind: "story", tags: ["priority-p2"] },
    })).json();
    for (const [name, tags, pageId] of [
      ["B", [group, "priority-p1"], null],
      ["A", [group, "p1"], null],
      ["C", [group], story.id],
      ["D", [group, "priority-p10"], null],
      ["E", [group], null],
    ] as const) {
      expect((await request.post("/api/sessions", {
        data: { id: crypto.randomUUID(), title: `${name} ${suffix}`, tags, page_id: pageId, no_event: true },
      })).ok()).toBeTruthy();
    }
    await page.goto(`/?view=${view}&story=tag:${group}`);
    await page.getByRole("button", { name: "Remove Touched sort", exact: true }).click();
    await page.getByLabel("Add sort field").selectOption("title");
    await page.getByLabel("Add sort field").selectOption("priority");
    await page.getByRole("button", { name: "Move Priority sort earlier", exact: true }).click();
    const titles = page.getByText(new RegExp(`^[A-E] ${suffix}$`));
    await expect(titles).toHaveText(["A", "B", "C", "D", "E"].map((name) => `${name} ${suffix}`));
    await page.getByRole("button", { name: "Reverse Priority sort", exact: true }).click();
    await expect(titles).toHaveText(["D", "C", "A", "B", "E"].map((name) => `${name} ${suffix}`));
    if (view === "list") {
      await page.getByRole("button", { name: /^SESSION/ }).click({ modifiers: ["Shift"] });
    } else {
      await page.getByRole("button", { name: "Reverse Session sort", exact: true }).click();
    }
    await expect(titles).toHaveText(["D", "C", "B", "A", "E"].map((name) => `${name} ${suffix}`));
  });
}
