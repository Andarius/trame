import { type APIRequestContext, expect, test } from "@playwright/test";

// Selection toolbar: a floating format bar over a textarea selection (bold /
// italic / code / link + shortcuts), and a comment bar over a rendered-markdown
// selection that anchors the comment to the selected text.
test.describe.configure({ mode: "serial" });

const TITLES = [
  "Selection format e2e",
  "Selection shortcut e2e",
  "Selection comment e2e",
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
  text: string,
  blockId: string,
) => {
  const r = await request.post("/api/pages", {
    data: { title, content: [{ id: blockId, type: "text", text }] },
  });
  return (await r.json() as { id: string }).id;
};

test("toolbar appears on a textarea selection and bold toggles **", async ({ page, request }) => {
  const id = await newPage(
    request,
    "Selection format e2e",
    "make this bold",
    "blk-fmt",
  );
  await page.goto(`/?view=page&page=${id}`);
  await page.locator("p", { hasText: "make this bold" }).click();
  const ta = page.locator('[data-block-id="blk-fmt"] textarea');
  await expect(ta).toBeFocused();
  const bold = page.getByTitle("Bold (Ctrl+B)");
  await expect(bold).not.toBeVisible();
  await page.keyboard.press("Control+a"); // select-all inside the block
  await expect(bold).toBeVisible();
  await bold.click();
  await expect(ta).toHaveValue("**make this bold**");
  // still selected — a second click unwraps
  await bold.click();
  await expect(ta).toHaveValue("make this bold");
});

test("Ctrl+B / Ctrl+E wrap the selection; the link button scaffolds []( )", async ({ page, request }) => {
  const id = await newPage(
    request,
    "Selection shortcut e2e",
    "wrap me",
    "blk-key",
  );
  await page.goto(`/?view=page&page=${id}`);
  await page.locator("p", { hasText: "wrap me" }).click();
  const ta = page.locator('[data-block-id="blk-key"] textarea');
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  await expect(ta).toHaveValue("**wrap me**");
  await page.keyboard.press("Control+b"); // toggle back off
  await expect(ta).toHaveValue("wrap me");
  await page.keyboard.press("Control+e");
  await expect(ta).toHaveValue("`wrap me`");
  await page.keyboard.press("Control+e");
  await expect(ta).toHaveValue("wrap me");
  // the unwrap re-selected the whole text — the toolbar is still up
  await page.getByTitle("Link (Ctrl+K)").click();
  await expect(ta).toHaveValue("[wrap me]()");
  await page.keyboard.type("https://example.com");
  await expect(ta).toHaveValue("[wrap me](https://example.com)");
});

test("selecting rendered text offers a comment anchored to the selection", async ({ page, request }) => {
  const id = await newPage(
    request,
    "Selection comment e2e",
    "pick out this fragment for review",
    "blk-cmt",
  );
  await page.goto(`/?view=page&page=${id}`);
  await expect(page.locator("p", { hasText: "pick out this fragment" }))
    .toBeVisible();
  // synthesize a selection over the rendered <p> (no textarea focused), then
  // the mouseup the toolbar listens for
  await page.evaluate(() => {
    const p = document.querySelector('[data-block-id="blk-cmt"] p');
    const r = document.createRange();
    r.selectNodeContents(p as Node);
    const s = document.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByTitle("Comment on selection").click();
  // composer quotes the selection it will anchor to
  await expect(page.getByText("on: “pick out this fragment for review”"))
    .toBeVisible();
  await page.getByPlaceholder("Add a comment… ⏎").fill("tighten this wording");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      await (await request.get(`/api/comments?page=${id}`)).json()
    )
    .toMatchObject([{
      block_id: "blk-cmt",
      anchor: "pick out this fragment for review",
      body: "tighten this wording",
    }]);
});
