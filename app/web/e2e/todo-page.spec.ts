import { type APIRequestContext, expect, test } from "@playwright/test";

// TODO-page layout (Open / Completed / Follow-ups with an inline screenshot):
// ○ rings mark items done, image clicks select instead of opening markdown,
// heading drags carry their section, and Ctrl+Z undoes structural edits.
test.describe.configure({ mode: "serial" });

// 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TITLES = ["Todo layout e2e", "Todo drag e2e", "Tabbed page e2e", "Folded page e2e"];

test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

const block = (type: "heading" | "text", text: string) => ({
  id: crypto.randomUUID(),
  type,
  text,
});

const newTodoPage = async (request: APIRequestContext, title: string) => {
  const up = await request.post("/api/assets", {
    headers: { "content-type": "image/png" },
    data: PNG,
  });
  const { id: assetId } = await up.json() as { id: string };
  const r = await request.post("/api/pages", {
    data: {
      title,
      content: [
        block("heading", "Open"),
        block(
          "text",
          `- **Verify start.sh**\n` +
            `- **Check why 2 CD** — ![screenshot](/api/assets/${assetId})\n` +
            `- **Second task** — some detail`,
        ),
        block("heading", "Completed"),
        block("text", "- **Old task** — note {{green:done 2026-08-01}}"),
        block("heading", "Follow-ups"),
        block("text", "- a reminder"),
      ],
    },
  });
  return (await r.json() as { id: string }).id;
};

test("○ ring moves the item to the top of Completed with a done pill", async ({ page, request }) => {
  const id = await newTodoPage(request, "Todo layout e2e");
  await page.goto(`/?view=page&page=${id}`);
  const rows = page.locator("[data-block-id]");
  await expect(page.getByTitle("Mark as done")).toHaveCount(3);

  await page.getByTitle("Mark as done").first().click(); // "Verify start.sh"
  // gone from the Open list, first in the Completed list, stamped with today's pill
  await expect(rows.nth(1)).not.toContainText("Verify start.sh");
  await expect(rows.nth(3)).toContainText("Verify start.sh");
  await expect(rows.nth(3)).toContainText(/done \d{4}-\d{2}-\d{2}/);
  const done = await rows.nth(3).innerText();
  expect(done.indexOf("Verify start.sh")).toBeLessThan(done.indexOf("Old task"));
  // ring click must not open the raw-markdown editor
  expect(await page.evaluate(() => document.activeElement?.tagName))
    .not.toBe("TEXTAREA");

  // the move persists (autosave)
  await expect.poll(async () => {
    const doc = await (await request.get(`/api/pages/${id}`)).json() as {
      content: unknown;
    };
    return JSON.stringify(doc.content);
  }).toContain("{{green:done ");

  // Ctrl+Z restores the item into the Open list
  await page.keyboard.press("Control+z");
  await expect(rows.nth(1)).toContainText("Verify start.sh");
  await expect(rows.nth(3)).not.toContainText("Verify start.sh");

  // ✓ un-checks: "Old task" loses its pill and lands at the end of the Open list
  await page.getByTitle("Mark as open").click();
  await expect(rows.nth(1)).toContainText("Old task");
  await expect(rows.nth(1)).not.toContainText("done 2026-08-01");
  const open = await rows.nth(1).innerText();
  expect(open.indexOf("Second task")).toBeLessThan(open.indexOf("Old task"));
  // its ring is live in the Open list now (3 seeded + the reopened one)
  await expect(page.getByTitle("Mark as done")).toHaveCount(4);
  // Ctrl+Z puts it back under Completed with the pill intact
  await page.keyboard.press("Control+z");
  await expect(rows.nth(3)).toContainText("done 2026-08-01");
});

test("image click selects the block; item click edits just that line", async ({ page, request }) => {
  const id = await newTodoPage(request, "Todo layout e2e");
  await page.goto(`/?view=page&page=${id}`);
  const rows = page.locator("[data-block-id]");
  const img = page.locator("img[src^='/api/assets/']");
  await expect(img).toBeVisible();

  await img.click();
  // no raw-markdown editing: focus is not in a textarea
  expect(await page.evaluate(() => document.activeElement?.tagName))
    .not.toBe("TEXTAREA");

  await page.getByText("Second task", { exact: true }).click();
  await page.waitForFunction(() =>
    document.activeElement?.tagName === "TEXTAREA"
  );
  // the editor holds only this item's markdown, not the whole block
  expect(
    await page.evaluate(() =>
      (document.activeElement as HTMLTextAreaElement).value
    ),
  ).toBe("**Second task** — some detail");

  // Enter commits the edit and opens a fresh item below; Escape drops it
  await page.keyboard.press("Control+a");
  await page.keyboard.type("**Second task** — edited");
  await page.keyboard.press("Enter");
  await expect(page.locator("li textarea")).toHaveValue(""); // fresh item open
  await page.keyboard.press("Escape");
  await expect(page.locator("li textarea")).not.toBeVisible();
  await expect(rows.nth(1)).toContainText("Second task — edited");
  await expect(rows.nth(1)).toContainText("Verify start.sh");

  // Ctrl+Z reverts the line edit (the dropped empty item is not an undo step)
  await page.keyboard.press("Control+z");
  await expect(rows.nth(1)).toContainText("Second task — some detail");
});

test("dragging a heading moves its whole section; Ctrl+Z undoes it", async ({ page, request }) => {
  const id = await newTodoPage(request, "Todo drag e2e");
  await page.goto(`/?view=page&page=${id}`);
  const rows = page.locator("[data-block-id]");
  await expect(rows).toHaveCount(6);

  const followUps = rows.filter({ hasText: "Follow-ups" });
  const completed = rows.filter({ hasText: "Completed" });
  await followUps.hover();
  const handle = followUps.locator("button[title='Drag to move']");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  const cb = (await completed.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 8 });
  await page.mouse.up();

  // heading and its list travelled together, above Completed
  await expect(rows.nth(2)).toContainText("Follow-ups");
  await expect(rows.nth(3)).toContainText("a reminder");
  await expect(rows.nth(4)).toContainText("Completed");

  await page.keyboard.press("Control+z");
  await expect(rows.nth(2)).toContainText("Completed");
  await expect(rows.nth(4)).toContainText("Follow-ups");
  await expect(rows.nth(5)).toContainText("a reminder");
});

test("{{tab}} headings group page blocks into a tab strip", async ({ page, request }) => {
  const r = await request.post("/api/pages", {
    data: {
      title: "Tabbed page e2e",
      content: [
        block("text", "intro line"),
        block("heading", "Alpha {{tab}}"),
        block("text", "- alpha content"),
        block("heading", "Beta {{tab}}"),
        block("text", "- beta content"),
      ],
    },
  });
  const { id } = await r.json() as { id: string };
  await page.goto(`/?view=page&page=${id}`);
  // preamble stays; first tab active, second hidden (hidden textareas mirror the
  // text, so scope assertions to rendered elements)
  await expect(page.locator("p", { hasText: "intro line" })).toBeVisible();
  await expect(page.locator("li", { hasText: "alpha content" })).toBeVisible();
  await expect(page.locator("li", { hasText: "beta content" })).not.toBeVisible();
  await page.getByRole("button", { name: "Beta" }).click();
  await expect(page.locator("li", { hasText: "beta content" })).toBeVisible();
  await expect(page.locator("li", { hasText: "alpha content" })).not.toBeVisible();
});

test("/fold slash command and {{fold}} accordion on a page", async ({ page, request }) => {
  const r = await request.post("/api/pages", {
    data: {
      title: "Folded page e2e",
      content: [
        block("text", "always visible"),
        block("heading", "Details {{fold}}"),
        block("text", "- hidden detail"),
      ],
    },
  });
  const { id } = await r.json() as { id: string };
  await page.goto(`/?view=page&page=${id}`);
  await expect(page.locator("p", { hasText: "always visible" })).toBeVisible();
  await expect(page.locator("li", { hasText: "hidden detail" })).not.toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator("li", { hasText: "hidden detail" })).toBeVisible();

  // the slash menu offers the section utilities
  await page.locator("li", { hasText: "hidden detail" }).click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("/fol");
  await expect(page.getByText("Folded section")).toBeVisible();
  await page.keyboard.press("Escape");
});
