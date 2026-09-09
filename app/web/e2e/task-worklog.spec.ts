import { expect, test } from "@playwright/test";

// A task line linked to a session carries that session's worklog: the chip opens the
// feed, entries render as Markdown, and an incomplete table row in a summary must not
// hang the renderer (it used to spin the block loop forever).
test.describe.configure({ mode: "serial" });

const PAGE_TITLE = "Task worklog e2e";
const SESSION_TITLE = "worklog session e2e";
const TASK = "Restart the pool";

test("a task line's chip opens the linked session's worklog", async ({ page, request }) => {
  // retry-safe: wipe leftovers from a previous run
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string }[];
  for (const p of pages.filter((x) => x.title === PAGE_TITLE)) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
  const board = await (await request.get("/api/board")).json() as {
    sessions: { id: string; title: string }[];
  };
  for (const s of board.sessions.filter((x) => x.title === SESSION_TITLE)) {
    await request.post(`/api/sessions/${s.id}/delete`, { data: {} });
  }

  const { id: pageId } = await (await request.post("/api/pages", {
    data: {
      title: PAGE_TITLE,
      content: [{ id: crypto.randomUUID(), type: "todo", text: TASK, done: false }],
    },
  })).json() as { id: string };

  const card = { title: SESSION_TITLE, repo_path: "/repos/worklog-e2e", branch: "e2e" };
  await request.post("/api/sessions", {
    data: { ...card, status: "active", summary: "First entry with `code`.\n| task | state |" },
  });
  // the agent path: no block id, just the task's text — the server resolves it
  await request.post("/api/sessions", {
    data: { ...card, summary: "Second entry", links: [{ page_id: pageId, anchor: TASK }] },
  });

  await page.goto(`/?view=page&page=${pageId}`);
  const chip = page.getByRole("button", { name: new RegExp(SESSION_TITLE) });
  await expect(chip).toBeVisible();
  await chip.click();

  // newest first, both entries, and the summary rendered as Markdown (not raw text)
  await expect(page.getByText("Second entry")).toBeVisible();
  await expect(page.getByText("First entry with")).toBeVisible();
  await expect(page.locator("code", { hasText: "code" })).toBeVisible();
});
