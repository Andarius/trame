import { expect, test } from "@playwright/test";

// Import-from-Claude-Code flow against the fixtures fabricated in global-setup:
// -repo-alpha/uuid1 (fresh, full metadata), uuid2 (backdated 20 days),
// plus a subagents/ transcript and a -tmp-* dir that must never be scanned.
test.describe.configure({ mode: "serial" });

const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const CODEX_UUID = "66666666-6666-4666-8666-666666666666";

// retry-safe: a retried run finds the cards from the failed attempt — wipe them first
test.beforeAll(async ({ request }) => {
  for (const id of [UUID1, UUID2, CODEX_UUID]) {
    await request.post(`/api/sessions/${id}/delete`).catch(() => {});
  }
});

test("scan previews sessions, filters by window, hides subagents and tmp dirs", async ({ page, request }) => {
  // a plain page must show up in the project picker as a promotable □ option
  await request.post("/api/pages", { data: { title: "Import notes", kind: "page" } });
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await expect(page.getByText("IMPORT FROM CLAUDE CODE + CODEX", { exact: true })).toBeVisible();
  // 7-day window: only uuid1 (last ai-title wins in the composed title)
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await expect(page.getByText("1 found", { exact: true })).toBeVisible();
  await expect(page.getByText("⎇ feat/import")).toBeVisible();
  // subagent and -tmp- fixtures never appear
  await expect(page.getByText(/tmp.scratch/)).not.toBeVisible();
  // 30-day window pulls in the backdated uuid2, titled from its first user prompt;
  // the empty aborted-launch fixture must never be listed
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await expect(page.getByText("2 found", { exact: true })).toBeVisible();
  await expect(page.getByText("alpha — fix the flaky retry test")).toBeVisible();
  // the story picker offers a free-text "new story" choice
  await page.getByRole("button", { name: /alpha \(create\)/ }).click();
  await page.getByRole("button", { name: /new story…/ }).click();
  await expect(page.getByPlaceholder("new story title (created on import)")).toBeVisible();
  // plain pages appear as promotable □ options
  await page.getByRole("button", { name: /new story…/ }).click(); // reopen the select
  // .last(): the sidebar tree also shows "□ Import notes" — the modal renders after it
  await page.getByRole("button", { name: "□ Import notes" }).last().click();
  await page.getByRole("button", { name: "□ Import notes" }).last().click(); // reopen, restore default
  await page.getByRole("button", { name: /alpha \(create\)/ }).click();
  // and the client picker a "new client" one
  await page.getByRole("button", { name: "Side-projects" }).click();
  await page.getByRole("button", { name: /new client…/ }).click();
  await expect(page.getByPlaceholder("new client name (created on import)")).toBeVisible();
  // global select/deselect all
  await page.getByRole("button", { name: "Deselect all" }).click();
  await expect(page.getByRole("button", { name: /Import 0 sessions/ })).toBeDisabled();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByRole("button", { name: /Import 2 sessions/ })).toBeEnabled();
  // text filter narrows to matching titles (search lives in the ▽ popover)
  await page.getByTitle("Filter").click();
  await page.getByPlaceholder(/filter .* sessions/).fill("flaky");
  await expect(page.getByTitle("alpha — fix the flaky retry test")).toBeVisible();
  await expect(page.getByTitle("alpha — Ship the import feature")).not.toBeVisible();
  await page.getByPlaceholder(/filter .* sessions/).fill("zzz-nothing");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("scan parses primary Codex rollouts, excludes subagents, and imports resumably", async ({ request }) => {
  const scan = await (await request.get("/api/import/claude?days=90")).json();
  const sessions = scan.groups.flatMap((g: { sessions: unknown[] }) => g.sessions) as {
    source: string;
    claudeId: string;
    title: string;
    branch: string | null;
  }[];
  const codex = sessions.filter((s) => s.source === "codex");
  expect(codex).toEqual([expect.objectContaining({
    claudeId: CODEX_UUID,
    title: "codex-project — parse Codex rollout sessions",
    branch: "feat/codex-import",
  })]);

  const item = {
    source: "codex",
    claudeId: CODEX_UUID,
    title: codex[0].title,
    repoPath: "/repo/codex-project",
    branch: codex[0].branch,
    client: "Side-projects",
    project: null,
    status: "paused",
    lastActive: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  };
  expect(await (await request.post("/api/import/claude", { data: { items: [item] } })).json())
    .toEqual({ imported: 1, skipped: 0, ids: [CODEX_UUID] });
  const resume = await (await request.post("/api/resume", { data: { id: CODEX_UUID, probe: true } })).json();
  expect(resume).toEqual(expect.objectContaining({
    agent: "codex",
    local: true,
    cmd: `cd '/repo/codex-project' && codex resume ${CODEX_UUID}`,
  }));
});

test("import creates the card, the auto project, and the worklog event", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await page.getByRole("button", { name: /Import 1 session\b/ }).click();
  // card lands on the board; the auto-created "alpha" story nests under its "Side-projects" project
  await expect(page.getByText("alpha — Ship the import feature")).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: /Side-projects/ })).toBeVisible();
  // drawer carries the import event
  await page.getByText("alpha — Ship the import feature").click();
  await expect(page.getByText("Imported from Claude Code · e2e")).toBeVisible(); // stamps the node
  await page.keyboard.press("Escape");
});

test("re-scan hides the imported session behind the state filter", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  // the default "new" view is empty: the 7d window has only the imported uuid1
  await expect(page.getByText(/switch the state filter/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Import 0 sessions/ })).toBeDisabled();
  // switching to "imported" reveals it, greyed (getByTitle: the same text is on the board behind)
  await page.getByTitle("Filter").click();
  await page.getByRole("button", { name: "new 0" }).click();
  await page.getByRole("button", { name: "imported 1" }).click();
  await expect(page.getByTitle("alpha — Ship the import feature")).toBeVisible();
  await expect(page.getByText("imported", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a session can be ignored, revealed via the filter, and restored", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await page.getByRole("button", { name: "30d", exact: true }).click();
  const row = page.locator("div", { hasText: "alpha — fix the flaky retry test" }).last();
  await row.hover();
  await row.getByTitle("Ignore this session").click();
  // row disappears, counts and footer update
  await expect(page.getByText("alpha — fix the flaky retry test")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Import 0 sessions/ })).toBeDisabled();
  // survives a reopen (persisted in the settings file); reveal via the state filter and restore
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Import from Claude Code/ }).click();
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await page.getByTitle("Filter").click();
  await page.getByRole("button", { name: "new 0" }).click();
  await page.getByRole("button", { name: "ignored 1" }).click();
  await page.keyboard.press("Escape"); // close the popover — it overlaps the row's ↩
  await expect(page.getByTitle("alpha — fix the flaky retry test")).toBeVisible();
  await page.getByTitle("Stop ignoring").click();
  await page.getByTitle("Filter").click();
  await page.getByRole("button", { name: "ignored 0" }).click();
  await page.getByRole("button", { name: "new 1" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByRole("button", { name: /Import 1 session\b/ })).toBeEnabled();
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
