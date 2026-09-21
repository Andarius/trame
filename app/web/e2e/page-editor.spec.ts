import { type APIRequestContext, expect, test } from "@playwright/test";

// Page-editor behaviors: /todo slash command, pasted images (upload → markdown →
// rendered <img> on blur), and the /api/assets round-trip behind them.
test.describe.configure({ mode: "serial" });

// 1×1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const TITLES = [
  "Editor todo e2e",
  "Editor image e2e",
  "Editor paste e2e",
  "Editor pill e2e",
  "Editor live e2e",
  "Editor list split e2e",
  "Editor undo e2e",
  "Editor insert e2e",
  "Editor tab e2e",
  "Editor table rows e2e",
  "Editor list inline e2e",
  "Editor table width e2e",
];

// retry-safe: wipe our fixture pages so a re-run starts clean
test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

const newPage = async (
  request: APIRequestContext,
  title: string,
  content: unknown[] = [],
) => {
  const r = await request.post("/api/pages", { data: { title, content } });
  return (await r.json() as { id: string }).id;
};

test("asset upload round-trips and rejects non-images", async ({ request }) => {
  const up = await request.post("/api/assets", {
    headers: { "content-type": "image/png" },
    data: PNG,
  });
  expect(up.ok()).toBeTruthy();
  const { id } = await up.json() as { id: string };
  const got = await request.get(`/api/assets/${id}`);
  expect(got.status()).toBe(200);
  expect(got.headers()["content-type"]).toBe("image/png");
  expect(await got.body()).toEqual(PNG);
  const bad = await request.post("/api/assets", {
    headers: { "content-type": "text/html" },
    data: "<b>nope</b>",
  });
  expect(bad.status()).toBe(400);
  expect((await request.get(`/api/assets/${crypto.randomUUID()}`)).status())
    .toBe(404);
});

test("/todo inserts a checkbox block", async ({ page, request }) => {
  const id = await newPage(request, "Editor todo e2e");
  await page.goto(`/?view=page&page=${id}`);
  const editor = page.getByPlaceholder(/type \/ for blocks/);
  await editor.fill("/todo");
  await expect(page.getByText("checkbox item")).toBeVisible();
  await page.keyboard.press("Enter");
  // ○ ring toggle appears; Enter continues the todo list on the next line
  await expect(page.getByTitle("Mark as done")).toBeVisible();
  await page.keyboard.type("first task");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second task");
  await page.keyboard.press("Enter"); // new empty ring
  await page.keyboard.press("Enter"); // Enter on the empty ring exits the list
  await expect(page.getByTitle("Mark as done")).toHaveCount(2);
  // checking an item sinks it below the open ones
  await page.getByTitle("Mark as done").first().click();
  await expect(page.getByTitle("Mark as open")).toBeVisible();
  const rows = page.locator("[data-block-id]");
  await expect(rows.nth(0)).toContainText("second task");
  await expect(rows.nth(1)).toContainText("first task");
});

test("image markdown renders as an <img>", async ({ page, request }) => {
  const up = await request.post("/api/assets", {
    headers: { "content-type": "image/png" },
    data: PNG,
  });
  const { id: assetId } = await up.json() as { id: string };
  const pageId = await newPage(request, "Editor image e2e", [
    // mid-text: regression for the tokenizer stopping at `!`
    { id: crypto.randomUUID(), type: "text", text: `before ![shot](/api/assets/${assetId}) after` },
  ]);
  await page.goto(`/?view=page&page=${pageId}`);
  const img = page.locator(`img[alt="shot"]`);
  await expect(img).toBeVisible();
  // actually decoded — not a broken-image placeholder or a link
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByRole("link", { name: "shot" })).not.toBeVisible();
});

test("{{pill}} syntax renders tinted chips in table cells", async ({ page, request }) => {
  const pageId = await newPage(request, "Editor pill e2e", [
    {
      id: crypto.randomUUID(),
      type: "text",
      text: "| Path | Project |\n| --- | --- |\n| {{green:saas-dev}} | {{ops: core}} |",
    },
  ]);
  await page.goto(`/?view=page&page=${pageId}`);
  const green = page.locator("td span.rounded-md", { hasText: "saas-dev" });
  await expect(green).toBeVisible();
  await expect(green).toHaveClass(/text-active/);
  await expect(green).toHaveText("saas-dev"); // color prefix stripped
  // unknown "word:" prefixes stay in the text and fall back to the neutral pill
  const gray = page.locator("td span.rounded-md", { hasText: "ops: core" });
  await expect(gray).toHaveClass(/text-ink-soft/);
});

test("table rows can be added, edited full-width and deleted", async ({ page, request }) => {
  const pageId = await newPage(request, "Editor table rows e2e", [
    {
      id: crypto.randomUUID(),
      type: "text",
      text: "| Path | Note |\n| --- | --- |\n| one | short |",
    },
  ]);
  await page.goto(`/?view=page&page=${pageId}`);
  await expect(page.locator("td", { hasText: "one" })).toBeVisible();

  await page.getByRole("button", { name: "+ Row" }).click();
  const editor = page.locator("td textarea");
  await editor.fill("a much longer value than the column is wide, on purpose");
  // the editor grows to its content instead of clipping it to one line
  expect(
    await editor.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await editor.press("Enter");
  await expect(page.locator("td", { hasText: "much longer value" })).toBeVisible();

  // Backspace inside a cell edits the text — it must not delete the selected block
  await page.locator("td", { hasText: "short" }).dblclick();
  await page.locator("td textarea").press("Backspace");
  await page.locator("td textarea").press("Enter");
  await expect(page.locator("td", { hasText: "shor" })).toBeVisible();
  await expect(page.locator("table")).toBeVisible();

  const row = page.locator("tbody tr", { hasText: "much longer value" });
  await row.hover();
  await row.getByRole("button", { name: "Delete this row" }).click();
  await expect(page.locator("td", { hasText: "much longer value" })).toHaveCount(0);
  await expect(page.locator("td", { hasText: "one" })).toBeVisible();
});

test("clicking a bullet block edits the line, not the whole block as raw", async ({ page, request }) => {
  const id = await newPage(request, "Editor list inline e2e", [
    {
      id: crypto.randomUUID(),
      type: "text",
      text: "- **one** alpha\n- **two** beta\n- **three** gamma",
    },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  const last = page.locator("li", { hasText: "gamma" });
  await expect(last).toBeVisible();

  // clicking past the end of a line edits that line in place — the rest of the
  // list keeps its bullets and bold instead of flipping to markdown source
  const box = (await last.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
  await expect(page.locator("li textarea")).toHaveValue("**three** gamma");
  await expect(page.locator("li strong", { hasText: "one" })).toBeVisible();

  // raw markdown stays one click away, in the block's hover toolbar
  await page.keyboard.press("Escape");
  await last.hover();
  await page.getByTitle("Raw markdown (edit / export)").click();
  await expect(page.locator("li strong", { hasText: "one" })).toBeHidden();
  await expect(page.locator("textarea")).toHaveValue(
    "- **one** alpha\n- **two** beta\n- **three** gamma",
  );
});

test("a dragged column keeps its width and widens the table", async ({ page, request }) => {
  const id = await newPage(request, "Editor table width e2e", [
    {
      id: crypto.randomUUID(),
      type: "text",
      text: "| Step | When | Who | Detail |\n|---|---|---|---|\n| one | now | them | a rather long sentence that wraps in a narrow column |",
    },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  const th = page.locator("th", { hasText: "Detail" });
  const before = (await th.boundingBox())!;

  const grip = th.locator("span[title='Drag to resize this column']");
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 300, g.y + g.height / 2, { steps: 10 });
  await page.mouse.up();
  expect((await th.boundingBox())!.width).toBeGreaterThan(before.width + 200);

  // the width rides in the separator row, so it survives a reload
  await expect.poll(async () =>
    (await (await request.get(`/api/pages/${id}`)).json()).content[0].text
  ).toMatch(/\|\s-{20,}\s\|/);
  await page.reload();
  await expect(page.locator("th", { hasText: "Detail" })).toBeVisible();
  expect((await page.locator("th", { hasText: "Detail" }).boundingBox())!.width)
    .toBeGreaterThan(before.width + 200);
});

test("remote edits appear live, but never over local typing", async ({ page, request }) => {
  const id = await newPage(request, "Editor live e2e", [
    { id: crypto.randomUUID(), type: "text", text: "first version" },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  // p, not getByText: each block also renders a hidden textarea with the same text
  await expect(page.locator("p", { hasText: "first version" })).toBeVisible();
  // an agent writes while the tab sits idle → the 5s content poll picks it up
  await request.post(`/api/pages/${id}`, {
    data: {
      content: [{ id: crypto.randomUUID(), type: "text", text: "agent version" }],
    },
  });
  await expect(page.locator("p", { hasText: "agent version" }))
    .toBeVisible({ timeout: 8000 });
  // while the user is typing in a block, remote content must not clobber the draft
  await page.locator("p", { hasText: "agent version" }).click();
  await page.keyboard.type(" plus draft");
  await request.post(`/api/pages/${id}`, {
    data: {
      content: [{ id: crypto.randomUUID(), type: "text", text: "clobber attempt" }],
    },
  });
  await page.waitForTimeout(6500); // let at least one poll tick pass
  await expect(page.locator("textarea:focus")).toHaveValue("agent version plus draft");
  await expect(page.locator("p", { hasText: "clobber attempt" })).not.toBeVisible();
});

test("pasting an image uploads it and renders on blur", async ({ page, request }) => {
  const id = await newPage(request, "Editor paste e2e");
  await page.goto(`/?view=page&page=${id}`);
  const editor = page.getByPlaceholder(/type \/ for blocks/);
  await editor.click();
  await editor.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, PNG_B64);
  await expect(editor).toHaveValue(/!\[image\]\(\/api\/assets\//);
  await page.getByPlaceholder("Untitled").click(); // blur the block → markdown renders
  const img = page.locator(`img[alt="image"]`);
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
});

test("Enter in a rendered list item splits it and keeps typing flowing", async ({ page, request }) => {
  const id = await newPage(request, "Editor list split e2e", [
    { id: "blk-list", type: "text", text: "- alpha\n- beta" },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  // click the item text → single-line editor with the caret at the end
  await page.locator("li", { hasText: "alpha" }).locator("span.cursor-text").click();
  const item = page.locator("li textarea");
  await expect(item).toHaveValue("alpha");
  await page.keyboard.press("Enter"); // split at end → fresh empty item, editor open
  await expect(item).toHaveValue("");
  await page.keyboard.type("gamma");
  await page.keyboard.press("Enter"); // commits gamma, opens the next fresh item
  await expect(item).toHaveValue("");
  await page.keyboard.press("Escape"); // exit — the dangling empty item is dropped
  await expect(item).not.toBeVisible();
  await expect
    .poll(async () => {
      const p = await (await request.get(`/api/pages/${id}`)).json() as {
        content: { text: string }[];
      };
      return p.content[0]?.text;
    })
    .toBe("- alpha\n- gamma\n- beta");
});

test("Ctrl+Z undoes a block delete and a typed run", async ({ page, request }) => {
  const id = await newPage(request, "Editor undo e2e", [
    { id: "u-a", type: "text", text: "alpha" },
    { id: "u-b", type: "text", text: "" },
    { id: "u-c", type: "text", text: "gamma" },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  const texts = () =>
    page.locator("textarea").evaluateAll((els) =>
      els.map((e) => (e as HTMLTextAreaElement).value)
    );

  // Backspace on the empty block deletes it and refocuses a sibling textarea —
  // Ctrl+Z must still reach the editor's undo stack from there
  await page.locator("textarea").nth(1).focus();
  await page.keyboard.press("Backspace");
  await expect.poll(texts).toEqual(["alpha", "gamma"]);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
  await page.keyboard.press("Control+z");
  await expect.poll(texts).toEqual(["alpha", "", "gamma"]);

  // a typed run stays with the browser's native undo, and undoes as one step
  await page.locator("textarea").first().focus();
  await page.keyboard.press("End");
  await page.keyboard.type("XYZ", { delay: 80 });
  await expect.poll(texts).toEqual(["alphaXYZ", "", "gamma"]);
  await page.keyboard.press("Control+z");
  await expect.poll(texts).toEqual(["alpha", "", "gamma"]);
});

test("a page opening on an html block stays writable around it", async ({ page, request }) => {
  const id = await newPage(request, "Editor insert e2e", [
    { id: "i-h", type: "html", html: "<!doctype html><title>Preview</title><body><h1>doc</h1>" },
    { id: "i-t", type: "heading", text: "Implementation progress" },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  const types = async () =>
    ((await (await request.get(`/api/pages/${id}`)).json()) as {
      content: { type: string }[];
    }).content.map((b) => b.type);

  // Enter on a block's first column opens a writable line above it
  await page.locator("textarea").first().focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.keyboard.type("above the heading");
  await expect.poll(types).toEqual(["html", "text", "heading"]);

  // the strip above a leading html block — nothing else can reach that slot
  await page.getByTitle("write above this block").click();
  await page.keyboard.type("above the preview");
  await expect.poll(types).toEqual(["text", "html", "text", "heading"]);

  // the ⋮⋮ handle reaches an html block too — drop it on the heading row
  const htmlRow = page.locator("div.group", { has: page.locator("iframe") }).first();
  await htmlRow.hover();
  await htmlRow.getByTitle("Drag to move").hover();
  await page.mouse.down();
  await page.locator("[data-block-id]").last().hover();
  await page.mouse.up();
  await expect.poll(types).toEqual(["text", "text", "heading", "html"]);
});

test("a tab drags along its strip, carrying its whole section", async ({ page, request }) => {
  const id = await newPage(request, "Editor tab e2e", [
    { id: "t-a", type: "heading", text: "Overview {{tab}}" },
    { id: "t-b", type: "text", text: "overview body" },
    { id: "t-c", type: "heading", text: "Map {{tab}}" },
    { id: "t-d", type: "text", text: "map body" },
    // a plain heading inside the tab: it belongs to Map, and must travel with it
    { id: "t-e", type: "heading", text: "Details" },
    { id: "t-f", type: "text", text: "details body" },
  ]);
  await page.goto(`/?view=page&page=${id}`);
  const map = page.getByRole("button", { name: "Map" });
  await map.hover();
  await page.mouse.down();
  const overview = page.getByRole("button", { name: "Overview" });
  await overview.hover();
  // the bar marks the side it lands on — left, since Map is dragged leftwards
  expect(await overview.evaluate((el) => getComputedStyle(el).boxShadow))
    .toMatch(/rgb\(201, 138, 99\).*-2px/);
  await page.mouse.up();
  await expect
    .poll(async () =>
      ((await (await request.get(`/api/pages/${id}`)).json()) as {
        content: { id: string }[];
      }).content.map((b) => b.id)
    )
    .toEqual(["t-c", "t-d", "t-e", "t-f", "t-a", "t-b"]);
  // the dragged tab stays the one you are looking at
  await expect(page.locator("p", { hasText: "map body" })).toBeVisible();
});
