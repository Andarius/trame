import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

// SQL source plugin (run from source by the e2e plugin host) against the backend's own
// PostgreSQL socket: configure in the plugins manager → Refresh → source cells read-only.
test.describe.configure({ mode: "serial" });

const SOCKET = `${process.env.TRAME_LOCAL_DIR ?? resolve("../../.scratch/stage1/e2e-db")}/socket`;
const DSN = `postgres://trame@localhost:55439/postgres?host=${SOCKET}`;
const QUERY = `select * from (values ('a', 'Alpha', 1), ('b', 'Beta', 2)) as t(key, "Name", score)`;
let dbId = "";

async function pickOption(page: Page, labelText: string, option: string) {
  const label = page.locator("label").filter({ has: page.getByText(labelText, { exact: true }) });
  await label.getByRole("button").first().click();
  await label.getByRole("button", { name: option }).last().click();
}

test("the plugin host serves sql-source", async ({ request }) => {
  // the host starts beside the backend, not before it
  await expect.poll(async () => {
    const list = await (await request.get("/api/plugins")).json() as { id: string }[];
    return list.some((p) => p.id === "sql-source");
  }, { timeout: 60_000 }).toBe(true);
  dbId = (await (await request.post("/api/udb", { data: { name: "Synced metrics" } })).json()).id;
});

test("configure a source in the plugins manager", async ({ page, request }) => {
  await page.goto("/");
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: /Manage plugins/ }).click();
  await page.getByRole("button", { name: /SQL source/ }).click();
  await expect(page.getByText(/sync to your hub and your other devices/)).toBeVisible();
  await page.getByRole("button", { name: /Add source/ }).click();
  await page.getByLabel("Source name").fill("Local metrics");
  await page.getByPlaceholder("postgres://user:pass@host:5432/db").fill(DSN);
  await page.locator("textarea").fill(QUERY);
  await pickOption(page, "TARGET DATABASE", "Synced metrics");
  await page.getByPlaceholder("id", { exact: true }).fill("key");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("✓ columns: key, Name, score")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("✓ Saved")).toBeVisible();
  await expect(page.getByPlaceholder("saved — leave empty to keep it")).toBeVisible();
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  // the connection string never comes back
  const view = await (await request.get("/api/plugins/sql-source/settings")).text();
  expect(view).not.toContain("trame@");
  expect(view).toContain('"hasDsn":true');
});

test("refresh fills the database; source cells are read-only, a user column is not", async ({ page, request }) => {
  await page.goto(`/?view=database&db=${dbId}`);
  await page.getByRole("button", { name: "⇣ Refresh" }).click();
  const rows = page.locator("main div.group\\/row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText(/refreshed now/)).toBeVisible();
  await expect(rows.first()).toContainText("Alpha");
  // source cells render as text, with no editor
  await expect(rows.first().locator("input, textarea, button.text-right")).toHaveCount(0);

  // a re-run with nothing changed writes nothing
  const source = (await (await request.get("/api/plugins/sql-source/status")).json()).sources[0];
  const again = await (await request.post(`/api/plugins/sql-source/refresh/${source.id}`)).json();
  expect(again).toMatchObject({ ok: true, rows: 2, created: 0, updated: 0, deleted: 0 });

  await request.post(`/api/udb/${dbId}/props`, { data: { name: "Note", type: "text", config: {} } });
  await page.reload();
  const note = rows.first().locator("input");
  await expect(note).toHaveCount(1);
  await note.fill("mine");
  await note.press("Enter");
  await expect.poll(async () => {
    const udb = await (await request.get(`/api/udb/${dbId}`)).json();
    const noteId = udb.properties.find((p: { name: string }) => p.name === "Note").id;
    return udb.rows.map((r: { vals: Record<string, unknown> }) => r.vals[noteId]).filter(Boolean);
  }).toEqual(["mine"]);
});
