import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

// SQL source against the backend's own PostgreSQL: connect from the database page →
// rows appear, source cells are read-only, a user column is not → disconnect.
test.describe.configure({ mode: "serial" });

const SOCKET = `${process.env.TRAME_LOCAL_DIR ?? resolve("../../.scratch/stage1/e2e-db")}/socket`;
const DSN = `host=${SOCKET} port=55439 user=trame dbname=postgres`;
const QUERY = `select * from (values ('a', 'Alpha', 1), ('b', 'Beta', 2)) as t(key, "Name", score)`;
const DB = "Synced metrics";

async function openDb(page: Page) {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: DB }).click();
}

test("connect a database to a query from its page", async ({ page, request }) => {
  await request.post("/api/udb", { data: { name: DB } });
  await openDb(page);
  await page.getByRole("button", { name: "⇣ Connect" }).click();
  await page.getByRole("button", { name: "Turn on" }).click(); // the plugin starts off
  await expect(page.getByRole("heading", { name: "Fill from a SQL query" })).toBeVisible();
  await expect(page.getByText(/sync to your hub and devices/)).toBeVisible();

  await page.getByLabel("Connection string").fill(DSN);
  await page.getByLabel("Query").fill(QUERY);
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByText("2 rows ·")).toBeVisible();
  await page.getByRole("button", { name: "pick the key column" }).click();
  await page.getByRole("button", { name: "key", exact: true }).click();
  await expect(page.getByText("＋ create 2 rows")).toBeVisible();
  await expect(page.getByText(/fill the existing\s*Name\s*column/)).toBeVisible();
  await page.getByRole("button", { name: "Connect & fill" }).click();

  const rows = page.locator("main div.group\\/row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Alpha");
  await expect(page.getByTitle("Refresh now")).toBeVisible();
  // source cells render as text, with no editor
  await expect(rows.first().locator("input, textarea")).toHaveCount(0);

  // the connection string never comes back
  const view = await (await request.get("/api/plugins/sql-source/settings")).text();
  expect(view).not.toContain("user=trame");
  expect(view).toContain('"hasDsn":true');
});

test("a re-run writes nothing and a user column stays editable", async ({ page, request }) => {
  const source = (await (await request.get("/api/plugins/sql-source/status")).json()).sources[0];
  const again = await (await request.post(`/api/plugins/sql-source/refresh/${source.id}`)).json();
  expect(again.status).toMatchObject({ rows: 2, created: 0, updated: 0, deleted: 0, error: null });

  await request.post(`/api/udb/${source.db_id}/props`, { data: { name: "Note", type: "text", config: {} } });
  await openDb(page);
  const note = page.locator("main div.group\\/row").first().locator("input");
  await expect(note).toHaveCount(1);
  await note.fill("mine");
  await note.press("Enter");
  await expect.poll(async () => {
    const udb = await (await request.get(`/api/udb/${source.db_id}`)).json();
    const noteId = udb.properties.find((p: { name: string }) => p.name === "Note").id;
    return udb.rows.map((r: { vals: Record<string, unknown> }) => r.vals[noteId]).filter(Boolean);
  }).toEqual(["mine"]);
});

test("disconnect keeps the rows and frees the columns", async ({ page }) => {
  await openDb(page);
  await page.getByRole("button", { name: "Source menu" }).click();
  await page.getByRole("button", { name: "Disconnect (keeps the rows)" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "⇣ Connect" })).toBeVisible();
  const rows = page.locator("main div.group\\/row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator("input").first()).toHaveValue("Alpha");
});

test("an inline database offers Connect and an unclipped column editor while editing", async ({ page, request }) => {
  const { id: pageId } = await (await request.post("/api/pages", { data: { title: "Inline SQL", kind: "page" } })).json();
  const { id: dbId } = await (await request.post("/api/udb", { data: { name: "Inline metrics" } })).json();
  await request.post(`/api/udb/${dbId}`, { data: { page_id: pageId } });
  for (let i = 0; i < 3; i++) await request.post(`/api/udb/${dbId}/rows`, { data: {} });
  await page.goto(`/?view=page&page=${pageId}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "⇣ Connect" })).toBeVisible();
  // the short table's scroll pane used to clip the column editor
  await page.getByRole("button", { name: /^Aa\s*Name/ }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeInViewport({ ratio: 1 });
});
