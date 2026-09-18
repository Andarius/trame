import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Sidebar drag-and-drop: what accepts what, and that the server keeps a re-homed
// story's client chip (client_id) pointing at its new project.
test.describe.configure({ mode: "serial" });

const TITLES = [
  "Drag proj A",
  "Drag proj B",
  "Drag story S",
  "Drag proj C",
  "Drag page P",
  "Drag page Q",
];

test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

const rowOf = (page: Page) => (title: string) =>
  page.locator("aside").first().locator("div.group", {
    has: page.getByText(title, { exact: true }),
  });

async function dragRow(page: Page, src: Locator, dst: Locator) {
  // park the cluster mid-list: grabbing near the aside's edge triggers dnd-kit's
  // autoscroll, which shifts every row out from under pre-measured coordinates
  await src.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const from = (await src.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // PointerSensor activates after 4px — nudge first, then travel to the target
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2);
  await page.mouse.move(from.x + from.width / 2 + 16, from.y + from.height / 2);
  // the drag must have activated (the source row dims) before travelling
  await expect(src).toHaveClass(/opacity-40/);
  // follow the target: rows can still shift mid-drag, so re-aim at its CURRENT
  // box each pass and release only once it lights up as the drop target
  await expect(async () => {
    const to = (await dst.boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 3,
    });
    await expect(dst).toHaveClass(/ring-copper/, { timeout: 250 });
  }).toPass({ timeout: 10_000 });
  await page.mouse.up();
}

const mkPage =
  (request: Page["request"]) => async (data: Record<string, unknown>) =>
    (await (await request.post("/api/pages", { data })).json() as {
      id: string;
    }).id;

const parentOf = async (request: Page["request"], id: string) => {
  const p = await (await request.get(`/api/pages/${id}`)).json() as {
    parent_id: string | null;
    client_id: string | null;
  };
  return p;
};

test("dragging a story onto another project re-homes it", async ({ page, request }) => {
  const mk = mkPage(request);
  const a = await mk({ title: "Drag proj A", kind: "project" });
  const b = await mk({ title: "Drag proj B", kind: "project" });
  const s = await mk({
    title: "Drag story S",
    kind: "story",
    parent_id: a,
    client_id: a,
  });

  await page.goto("/");
  const row = rowOf(page);
  // reveal the story under project A
  await row("Drag proj A").locator("button").first().click();
  const src = row("Drag story S");
  await expect(src).toBeVisible();
  await dragRow(page, src, row("Drag proj B"));

  await expect
    .poll(async () => {
      const p = await parentOf(request, s);
      return `${p.parent_id}:${p.client_id}`;
    })
    .toBe(`${b}:${b}`);
});

test("dragging a page onto another page nests it", async ({ page, request }) => {
  const mk = mkPage(request);
  const proj = await mk({ title: "Drag proj C", kind: "project" });
  const p1 = await mk({ title: "Drag page P", parent_id: proj });
  const q = await mk({ title: "Drag page Q", parent_id: proj });

  await page.goto("/");
  const row = rowOf(page);
  await row("Drag proj C").locator("button").first().click();
  const src = row("Drag page P");
  await expect(src).toBeVisible();
  await dragRow(page, src, row("Drag page Q"));

  await expect.poll(async () => (await parentOf(request, p1)).parent_id).toBe(
    q,
  );
});
