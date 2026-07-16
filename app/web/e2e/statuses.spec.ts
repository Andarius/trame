import { type APIRequestContext, expect, test } from "@playwright/test";

// User-defined kanban statuses (columns): CRUD over /api/statuses + the board and
// project-page surfaces, incl. the terminal-flag generalization (a custom "done-like"
// column counts as done on the project page, no longer just the built-in "done").
//
// Single shared backend: these tests only ever ADD custom statuses and clean them up,
// never delete a built-in, so board.spec and friends keep their four columns.
test.describe.configure({ mode: "serial" });

const BUILTINS = ["active", "paused", "blocked", "done"];
type Status = { id: string; key: string; label: string; color: string; terminal: boolean; sort_key: string };

const statuses = async (request: APIRequestContext): Promise<Status[]> =>
  (await (await request.get("/api/board")).json()).statuses;
const byLabel = async (request: APIRequestContext, label: string) =>
  (await statuses(request)).find((s) => s.label === label);

async function cleanup(request: APIRequestContext) {
  for (const s of (await statuses(request)).filter((x) => !BUILTINS.includes(x.key))) {
    await request.post(`/api/statuses/${s.id}/delete`).catch(() => {});
  }
  const board = await (await request.get("/api/board")).json() as { sessions: { id: string; title: string }[] };
  for (const s of board.sessions.filter((x) => x.title.startsWith("statuses e2e"))) {
    await request.post(`/api/sessions/${s.id}/delete`, { data: {} });
  }
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string }[];
  for (const p of pages.filter((x) => x.title === "Statuses Project")) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
}

test.beforeAll(async ({ request }) => await cleanup(request)); // retry-safe
test.afterAll(async ({ request }) => await cleanup(request)); // leave the board as we found it

test("board ships the four built-in statuses with fixed keys", async ({ request }) => {
  const list = await statuses(request);
  expect(list.map((s) => s.key)).toEqual(expect.arrayContaining(BUILTINS));
  expect(list.find((s) => s.key === "done")?.terminal).toBe(true);
  expect(list.find((s) => s.key === "active")?.terminal).toBe(false);
});

test("create, rename, recolor and reorder a custom status", async ({ request }) => {
  const { id } = await (await request.post("/api/statuses", {
    data: { label: "Review", color: "#56b6c2", terminal: false },
  })).json();
  let review = await byLabel(request, "Review");
  expect(review).toMatchObject({ key: "review", color: "#56b6c2", terminal: false });

  // rename + recolor via PATCH (key stays immutable)
  await request.post(`/api/statuses/${id}`, { data: { label: "In review", color: "#7a9ee7" } });
  review = (await statuses(request)).find((s) => s.id === id);
  expect(review).toMatchObject({ key: "review", label: "In review", color: "#7a9ee7" });

  // move it one slot towards the front and assert the order actually changed
  const before = (await statuses(request)).map((s) => s.id);
  await request.post(`/api/statuses/${id}/move`, { data: { dir: -1 } });
  const after = (await statuses(request)).map((s) => s.id);
  expect(after).not.toEqual(before);
  expect(after.indexOf(id)).toBeLessThan(before.indexOf(id));

  await request.post(`/api/statuses/${id}/delete`);
  expect(await byLabel(request, "In review")).toBeUndefined();
});

test("deleting a status reassigns its orphaned cards", async ({ request }) => {
  const { id } = await (await request.post("/api/statuses", {
    data: { label: "Parking", color: "#8b93a3" },
  })).json();
  const parking = await byLabel(request, "Parking");
  const s = await (await request.post("/api/sessions", {
    data: { title: "statuses e2e reassign", no_event: true },
  })).json();
  await request.post(`/api/sessions/${s.id}/status`, { data: { status: parking!.key } });

  // deleting the column must not orphan the card — it lands on a surviving status
  await request.post(`/api/statuses/${id}/delete`);
  const board = await (await request.get("/api/board")).json() as { sessions: { id: string; status: string }[] };
  const moved = board.sessions.find((x) => x.id === s.id)!;
  expect(moved.status).not.toBe("parking");
  expect((await statuses(request)).map((x) => x.key)).toContain(moved.status);
});

test("a custom terminal status counts as done on the project page", async ({ page, request }) => {
  const { id } = await (await request.post("/api/statuses", {
    data: { label: "Shipped", color: "#6b7280", terminal: true },
  })).json();
  const shipped = (await statuses(request)).find((s) => s.id === id)!;

  await request.post("/api/objectives", { data: { title: "Statuses Project", story: "custom terminal status" } });
  await request.post("/api/sessions", {
    data: { title: "statuses e2e open", objective: "Statuses Project", no_event: true },
  });
  const closed = await (await request.post("/api/sessions", {
    data: { title: "statuses e2e closed", objective: "Statuses Project", no_event: true },
  })).json();
  await request.post(`/api/sessions/${closed.id}/status`, { data: { status: shipped.key } });

  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Statuses Project/ }).first().click();
  // the terminal session is counted as done — regression guard for the old hardcoded
  // `status === "done"` that ignored user-defined terminal columns
  await expect(page.getByText("1 / 2 done")).toBeVisible();
});
