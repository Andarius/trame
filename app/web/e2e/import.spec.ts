import { expect, test } from "@playwright/test";

// Import-from-Claude-Code flow against the fixtures fabricated in global-setup:
// -repo-alpha/uuid1 (fresh, full metadata), uuid2 (backdated 20 days),
// plus a subagents/ transcript and a -tmp-* dir that must never be scanned.
test.describe.configure({ mode: "serial" });

const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

// retry-safe: a retried run finds the cards from the failed attempt — wipe them first
test.beforeAll(async ({ request }) => {
  for (const id of [UUID1, UUID2]) {
    await request.post(`/api/sessions/${id}/delete`).catch(() => {});
  }
});

test("scan previews sessions, filters by window, hides subagents and tmp dirs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await expect(page.getByText("IMPORT FROM CLAUDE CODE", { exact: true })).toBeVisible();
  // 7-day window: only uuid1 (last ai-title wins in the composed title)
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await expect(page.getByText(/1 found/)).toBeVisible();
  await expect(page.getByText("⎇ feat/import")).toBeVisible();
  // subagent and -tmp- fixtures never appear
  await expect(page.getByText(/tmp.scratch/)).not.toBeVisible();
  // 30-day window pulls in the backdated uuid2, titled from its first user prompt;
  // the empty aborted-launch fixture must never be listed
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await expect(page.getByText(/2 found/)).toBeVisible();
  await expect(page.getByText("alpha — fix the flaky retry test")).toBeVisible();
  // the project picker offers a free-text "new project" choice
  await page.getByRole("button", { name: /alpha \(create\)/ }).click();
  await page.getByRole("button", { name: /new project…/ }).click();
  await expect(page.getByPlaceholder("new project title (created on import)")).toBeVisible();
  // global select/deselect all
  await page.getByRole("button", { name: "Deselect all" }).click();
  await expect(page.getByRole("button", { name: /Import 0 sessions/ })).toBeDisabled();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByRole("button", { name: /Import 2 sessions/ })).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("import creates the card, the auto project, and the worklog event", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await page.getByRole("button", { name: /Import 1 session\b/ }).click();
  // card lands on the board, project "alpha" was find-or-created in the sidebar
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: /alpha/ })).toBeVisible();
  // drawer carries the import event
  await page.getByText("alpha — Ship the import feature").click();
  await expect(page.getByText("Imported from Claude Code")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("re-scan greys the imported session and disables the footer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await expect(page.getByText("imported", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Import 0 sessions/ })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("import is create-only: a second POST for the same id skips", async ({ request }) => {
  const item = {
    claudeId: UUID1,
    title: "alpha — clobber attempt",
    repoPath: "/repo/alpha",
    branch: null,
    client: "Side-projects",
    project: null,
    status: "paused",
    lastActive: new Date().toISOString(),
  };
  const res = await request.post("/api/import/claude", { data: { items: [item] } });
  expect(await res.json()).toEqual({ imported: 0, skipped: 1, ids: [] });
  // the original card is untouched
  const board = await (await request.get("/api/board")).json();
  const card = board.sessions.find((s: { id: string }) => s.id === UUID1);
  expect(card.title).toBe("alpha — Ship the import feature");
  expect(card.status).toBe("active");
});
