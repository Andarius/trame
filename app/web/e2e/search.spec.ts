import { expect, test } from "@playwright/test";

// Quick-find: the /api/search endpoint (sessions, pages, clients, databases, recency
// ranked) and its Ctrl+P command-palette surface.
test.describe.configure({ mode: "serial" });

const TITLE = "quickfind zephyr session";

test.beforeAll(async ({ request }) => {
  const board = await (await request.get("/api/board")).json() as { sessions: { id: string; title: string }[] };
  for (const s of board.sessions.filter((x) => x.title === TITLE)) {
    await request.post(`/api/sessions/${s.id}/delete`, { data: {} });
  }
});

test("search matches by title and returns recent items on an empty query", async ({ request }) => {
  await request.post("/api/sessions", { data: { title: TITLE, no_event: true } });

  const hits = await (await request.get(`/api/search?q=zephyr`)).json() as { kind: string; title: string }[];
  expect(hits.some((h) => h.kind === "session" && h.title === TITLE)).toBe(true);

  // empty query = the 20 most-recently-touched items (the palette's initial list)
  const recent = await (await request.get(`/api/search?q=`)).json() as unknown[];
  expect(recent.length).toBeGreaterThan(0);
  expect(recent.length).toBeLessThanOrEqual(20);

  // LIKE metacharacters are escaped: "%" matches a literal %, not everything
  const pct = await (await request.get(`/api/search?q=${encodeURIComponent("%")}`)).json() as { title: string }[];
  expect(pct.some((h) => h.title === TITLE)).toBe(false); // no wildcard blow-up
  expect(pct.every((h) => h.title.includes("%"))).toBe(true);
});

test("Ctrl+P opens the palette; typing filters; Enter opens the session drawer", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+p");
  const input = page.getByPlaceholder("Search sessions, pages, projects, databases…");
  await expect(input).toBeVisible();

  await input.fill("zephyr");
  // scope to real <button> results (the board card behind the palette is a div[role=button])
  const hit = page.locator("button").filter({ hasText: TITLE });
  await expect(hit).toBeVisible();

  // opening a session hit navigates to its drawer
  await hit.click();
  await expect(input).toBeHidden();
  await expect(page.getByTitle("close (esc)")).toBeVisible(); // the session drawer is open
  await expect(page.locator("textarea").first()).toHaveValue(TITLE); // …on the right session

  // Ctrl+P toggles it closed again
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  await expect(page.getByPlaceholder("Search sessions, pages, projects, databases…")).toBeVisible();
  await page.keyboard.press("Control+p");
  await expect(page.getByPlaceholder("Search sessions, pages, projects, databases…")).toBeHidden();
});
