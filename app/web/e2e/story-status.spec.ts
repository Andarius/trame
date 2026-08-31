import { expect, test } from "@playwright/test";

// Story status becomes visible: done stories dim and sink in the sidebar,
// archived ones fold into "Archived (n)", leave pickers, and tag their lane.
test.describe.configure({ mode: "serial" });

const TITLES = [
  "Status proj",
  "Status open S",
  "Status done S",
  "Status arch S",
  "Status arch2 S",
];

test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
  const mk = async (data: Record<string, unknown>) =>
    (await (await request.post("/api/pages", { data })).json() as {
      id: string;
    }).id;
  const proj = await mk({ title: "Status proj", kind: "project" });
  // done first so the done-last sort actually reorders it past the open story
  const done = await mk({
    title: "Status done S",
    kind: "story",
    parent_id: proj,
    client_id: proj,
  });
  await mk({
    title: "Status open S",
    kind: "story",
    parent_id: proj,
    client_id: proj,
  });
  const arch = await mk({
    title: "Status arch S",
    kind: "story",
    parent_id: proj,
    client_id: proj,
  });
  const arch2 = await mk({
    title: "Status arch2 S",
    kind: "story",
    parent_id: proj,
    client_id: proj,
  });
  await request.post(`/api/pages/${done}`, { data: { status: "done" } });
  await request.post(`/api/pages/${arch}`, { data: { status: "archived" } });
  await request.post(`/api/pages/${arch2}`, { data: { status: "archived" } });
  // a session on the archived story keeps its lane + drawer chip alive
  await request.post("/api/sessions", {
    data: { title: "status probe session", page_id: arch, no_event: true },
  });
});

test("sidebar dims done stories, sorts them last, folds archived ones", async ({ page }) => {
  await page.goto("/");
  const aside = page.locator("aside").first();
  const row = (title: string) =>
    aside.locator("div.group", { has: page.getByText(title, { exact: true }) });
  await row("Status proj").locator("button").first().click();

  await expect(row("Status open S")).toBeVisible();
  await expect(row("Status done S")).toHaveClass(/opacity-60/);
  const openBox = (await row("Status open S").boundingBox())!;
  const doneBox = (await row("Status done S").boundingBox())!;
  expect(doneBox.y).toBeGreaterThan(openBox.y);

  // archived stories hide behind the fold until it's expanded
  // (scoped to the sidebar — board cards may show the story name too)
  await expect(aside.getByText("Status arch S", { exact: true })).toHaveCount(
    0,
  );
  await aside.getByRole("button", { name: "Archived (2)" }).click();
  await expect(row("Status arch S")).toBeVisible();
  await expect(row("Status arch2 S")).toBeVisible();

  // both the project and fold expansion persist across a reload
  await page.reload();
  await expect(row("Status arch S")).toBeVisible();
});

test("story picker hides archived stories but keeps the attached one", async ({ page }) => {
  await page.goto("/");
  await page.getByText("status probe session").click();
  // the drawer Select still shows the archived story it's attached to
  const trigger = page.getByRole("button", { name: "◇ Status arch S ▾" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  // done stories stay pickable; the other archived story is gone
  await expect(page.getByRole("button", { name: "◇ Status done S" }).first())
    .toBeVisible();
  await expect(page.getByRole("button", { name: "◇ Status arch2 S" }))
    .toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("board lanes tag archived stories and drop empty ones", async ({ page }) => {
  await page.goto("/?group=story");
  await expect(page.getByText("Status arch S (archived)")).toBeVisible();
  // no sessions → no lane (and the sidebar keeps it folded away)
  await expect(page.getByText("Status arch2 S")).toHaveCount(0);
});
