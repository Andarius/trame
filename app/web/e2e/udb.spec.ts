import { expect, type Page, test } from "@playwright/test";

// custom Select (native <select> is unstylable in the desktop webview): click the
// trigger inside the exact-named label, then the option button that appears
async function pickOption(page: Page, labelText: string, option: string) {
  const label = page.locator("label").filter({ has: page.getByText(labelText, { exact: true }) });
  await label.getByRole("button").first().click();
  await label.getByRole("button", { name: option }).last().click();
}

// User-defined databases: one serialized flow on the shared fresh backend —
// create db → typed columns → rows/cells → relations (two-way) → formula →
// rollup → resize → icons → delete.
test.describe.configure({ mode: "serial" });

// 1x1 red PNG — used to verify the icon gallery lists image icons
const PNG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("create a database via the modal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New database/ }).click();
  await page.getByPlaceholder(/Benchmarks, Metrics log/).fill("Bench");
  await page.getByRole("button", { name: /Create database/ }).click();
  // lands on the new table: title column + empty state
  await expect(page.getByRole("button", { name: /Name/ })).toBeVisible();
  await expect(page.getByText("No rows yet")).toBeVisible();
});

test("add number and select columns", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  // number column
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("Score");
  await pickOption(page, "TYPE", "# Number");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Score/ })).toBeVisible();
  // select column (options created later, inline from the cell)
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("Priority");
  await pickOption(page, "TYPE", "▾ Select");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Priority/ })).toBeVisible();
});

test("create a row and edit cells in the grid", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  await page.getByRole("button", { name: /＋ New row/ }).click();
  // creating a row opens the row panel — set the title there, then close
  const title = page.locator("textarea");
  await title.fill("row-1");
  await page.getByText("auto-saves").click(); // blur commits
  await expect(page.getByText("✓ Saved")).toBeVisible();
  await page.keyboard.press("Escape");
  // scope to main — the sidebar's page tree rows also carry Tailwind's .group
  await expect(page.locator("main div.group input").first()).toHaveValue("row-1");
  // number cell: click-to-edit, Enter commits
  const row = page.locator("main div.group").first();
  await row.locator("button.text-right").click();
  await row.locator("input.text-right").fill("42");
  await row.locator("input.text-right").press("Enter");
  await expect(row.getByRole("button", { name: "42" })).toBeVisible();
});

test("select cell creates an option inline", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  const row = page.locator("main div.group").first();
  // the select cell is the empty flex-wrap button in the Priority column (3rd cell)
  await row.locator("div.relative > button.flex-wrap").first().click();
  await page.getByPlaceholder("filter…").fill("High");
  await page.getByRole("button", { name: /create “High”/ }).click();
  await expect(row.getByText("High")).toBeVisible();
});

test("two-way relation: reverse property auto-created, links visible from both sides", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New database/ }).click();
  await page.getByPlaceholder(/Benchmarks, Metrics log/).fill("Refs");
  await page.getByRole("button", { name: /Create database/ }).click();
  await expect(page.getByText("No rows yet")).toBeVisible();

  // one target row in Refs, via the API for brevity
  const dbs = await (await request.get("/api/udb")).json() as { id: string; name: string }[];
  const refs = dbs.find((d) => d.name === "Refs")!;
  const refsData = await (await request.get(`/api/udb/${refs.id}`)).json();
  const refsTitle = refsData.properties.find((p: { type: string }) => p.type === "title").id;
  await request.post(`/api/udb/${refs.id}/rows`, { data: { vals: { [refsTitle]: "target-1" } } });

  // relation column on Bench → Refs
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("Refs");
  await pickOption(page, "TYPE", "⇄ Relation");
  await pickOption(page, "RELATED TO", "Refs");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // link from the owner side via the picker
  const row = page.locator("main div.group").first();
  await row.locator("div.relative > button.flex-wrap").nth(1).click();
  await page.getByPlaceholder("search rows…").fill("target");
  await page.getByRole("button", { name: "target-1" }).click();
  await page.keyboard.press("Escape");
  await expect(row.getByText("target-1")).toBeVisible();

  // reverse side: Refs got a "Bench" relation column with the link
  await page.getByRole("button", { name: "Refs" }).first().click();
  await expect(page.getByRole("button", { name: "⇄ Bench" })).toBeVisible();
  await expect(page.locator("main div.group").first().getByText("row-1")).toBeVisible();
});

test("formula: SQL expression computes; invalid expression is rejected at save", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("Double");
  await pickOption(page, "TYPE", "ƒ Formula");
  await page.getByLabel("SQL EXPRESSION").fill("score * 2");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("main div.group").first().getByText("84")).toBeVisible();
  // invalid: unknown identifier surfaces the server error inline
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("Broken");
  await pickOption(page, "TYPE", "ƒ Formula");
  await page.getByLabel("SQL EXPRESSION").fill("bogus_prop + 1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/unknown identifier "bogus_prop"/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("rollup: count over the relation", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  await page.getByTitle("add column").click();
  await page.getByLabel("NAME").fill("RefCount");
  await pickOption(page, "TYPE", "∑ Rollup");
  await pickOption(page, "RELATION", "Refs");
  await pickOption(page, "CALCULATE", "count");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("main div.group").first().getByText("1", { exact: true })).toBeVisible();
});

test("column resize persists across reload", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  const header = page.getByRole("button", { name: /Name/ });
  const before = (await header.boundingBox())!.width;
  const handle = page.locator('div[title="drag to resize"]').first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 15, { steps: 6 });
  await page.mouse.up();
  await page.reload();
  await page.getByRole("button", { name: "Bench" }).click();
  const after = (await page.getByRole("button", { name: /Name/ }).boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
});

test("icons: emoji on a row, image icons listed in the gallery", async ({ page, request }) => {
  // an image icon in use (via API) so the gallery has something to list
  const dbs = await (await request.get("/api/udb")).json() as { id: string; name: string }[];
  const refs = dbs.find((d) => d.name === "Refs")!;
  const refsData = await (await request.get(`/api/udb/${refs.id}`)).json();
  await request.post(`/api/udb/rows/${refsData.rows[0].id}`, { data: { vals: {}, icon: PNG_ICON } });

  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  // emoji via the picker on the first row
  await page.locator('button[title="row icon"]').first().click();
  await page.getByRole("button", { name: "🎯" }).click();
  await expect(page.locator("main div.group").first().getByText("🎯")).toBeVisible();
  // gallery tab lists the image icon
  await page.locator('button[title="row icon"]').first().click();
  await page.getByRole("button", { name: "Icons", exact: true }).click();
  await expect(page.locator(`img[src="${PNG_ICON}"]`)).toBeVisible();
  await page.keyboard.press("Escape");
  // database icon from the header
  await page.locator('button[title="database icon"]').click();
  await page.getByRole("button", { name: "🧪" }).click();
  await expect(page.locator("aside").getByText("🧪")).toBeVisible();
});

test("row panel deletes a row; header deletes the database", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: "Bench" }).click();
  // confirms are the styled in-app modal now (native dialogs are unusable in the webview)
  const confirmDelete = () => page.locator("div.fixed").getByRole("button", { name: "Delete", exact: true }).click();
  // delete the row from the panel
  await page.locator('button[title="open row"]').first().click();
  await page.getByRole("button", { name: "Delete row" }).click();
  await confirmDelete();
  await expect(page.getByText("No rows yet")).toBeVisible();
  // delete both databases from the header
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmDelete();
  await expect(page.locator("aside").getByText("Bench")).not.toBeVisible();
  await page.getByRole("button", { name: "Refs" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmDelete();
  await expect(page.locator("aside").getByText("Refs")).not.toBeVisible();
});
