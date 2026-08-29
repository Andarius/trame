import { expect, test } from "@playwright/test";

// Sidebar drag-and-drop: stories can be re-homed onto another project; the
// server keeps their client chip (client_id) pointing at the new project.
test.describe.configure({ mode: "serial" });

const TITLES = ["Drag proj A", "Drag proj B", "Drag story S"];

test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

test("dragging a story onto another project re-homes it", async ({ page, request }) => {
  const mk = async (data: Record<string, unknown>) =>
    (await (await request.post("/api/pages", { data })).json() as {
      id: string;
    }).id;
  const a = await mk({ title: "Drag proj A", kind: "project" });
  const b = await mk({ title: "Drag proj B", kind: "project" });
  const s = await mk({
    title: "Drag story S",
    kind: "story",
    parent_id: a,
    client_id: a,
  });

  await page.goto("/");
  const aside = page.locator("aside").first();
  const row = (title: string) =>
    aside.locator("div.group", { has: page.getByText(title, { exact: true }) });
  // reveal the story under project A
  await row("Drag proj A").locator("button").first().click();
  const src = row("Drag story S");
  await expect(src).toBeVisible();

  const from = (await src.boundingBox())!;
  const to = (await row("Drag proj B").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // PointerSensor activates after 4px — nudge first, then travel to the target
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const p = await (await request.get(`/api/pages/${s}`)).json() as {
        parent_id: string | null;
        client_id: string | null;
      };
      return `${p.parent_id}:${p.client_id}`;
    })
    .toBe(`${b}:${b}`);
});
