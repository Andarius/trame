import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Starred pages sort to the top of their siblings, at every level of the tree.
const ROOTS = ["Star proj 1", "Star proj 2"];
const NEST = { proj: "Star proj 3", kids: ["Star kid A", "Star kid B"] };

test.beforeAll(async ({ request }) => {
  const all = [...ROOTS, NEST.proj, ...NEST.kids];
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => all.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

const rowOf = (page: Page) => (title: string) =>
  page.locator("aside").first().locator("div.group", {
    has: page.getByText(title, { exact: true }),
  });

// titles of the sidebar rows matching `needle`, in render order
const orderOf = (page: Page) => async (needle: string) =>
  (await page.locator("aside").first().locator("div.group").allTextContents())
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.includes(needle));

const star = async (page: Page, title: string) => {
  const row = rowOf(page)(title);
  await row.hover();
  await row.getByTitle(/star —/).click();
  await expect(row.getByTitle("unstar")).toBeVisible();
};

test("starring a project floats it to the top of PROJECTS", async ({ page, request }) => {
  for (const title of ROOTS) {
    await request.post("/api/pages", { data: { title, kind: "project" } });
  }

  await page.goto("/");
  const order = orderOf(page);
  await expect(rowOf(page)(ROOTS[1])).toBeVisible();
  expect(await order("Star proj")).toEqual(ROOTS.map(expect.stringContaining));

  await star(page, ROOTS[1]);
  expect(await order("Star proj")).toEqual(
    [...ROOTS].reverse().map(expect.stringContaining),
  );
});

test("a starred sub-page floats to the top of its project", async ({ page, request }) => {
  const mk = async (data: Record<string, unknown>) =>
    (await (await request.post("/api/pages", { data })).json() as {
      id: string;
    }).id;
  const proj = await mk({ title: NEST.proj, kind: "project" });
  for (const title of NEST.kids) await mk({ title, parent_id: proj });

  await page.goto("/");
  const order = orderOf(page);
  await rowOf(page)(NEST.proj).locator("button").first().click(); // expand
  await expect(rowOf(page)(NEST.kids[1])).toBeVisible();
  expect(await order("Star kid")).toEqual(
    NEST.kids.map(expect.stringContaining),
  );

  await star(page, NEST.kids[1]);
  expect(await order("Star kid")).toEqual(
    [...NEST.kids].reverse().map(expect.stringContaining),
  );
});
