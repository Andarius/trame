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
