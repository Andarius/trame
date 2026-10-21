import { type APIRequestContext, expect, test } from "@playwright/test";

// `decision` fence: renders the question and options, a pick writes the answer marks
// back into the block's markdown, and a reload shows it answered.
test.describe.configure({ mode: "serial" });

const TITLE = "Decision fence e2e";
const FENCE = [
  "```decision",
  "Grafana path saas-dev → saas-ops",
  "ingest port grafana-api | recommended",
  "no Grafana in v1",
  "{{trame:ask=@julien}} {{trame:due=2030-01-01}}",
  "```",
].join("\n");

const blockText = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/pages/${id}`)).json()) as { content: { text: string }[] }).content[0].text;

test.beforeAll(async ({ request }) => {
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string }[];
  for (const p of pages.filter((p) => p.title === TITLE)) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
});

test("a pick records answer, answered_by and completed_at in the fence", async ({ page, request }) => {
  const r = await request.post("/api/pages", {
    data: { title: TITLE, content: [{ id: crypto.randomUUID(), type: "text", text: FENCE }] },
  });
  const id = (await r.json() as { id: string }).id;
  await page.goto(`/?view=page&page=${id}`);

  // span, not getByText: the block also renders a hidden textarea with the same source
  await expect(page.locator("span", { hasText: "Grafana path saas-dev → saas-ops" })).toBeVisible();
  await expect(page.locator("span", { hasText: "waiting on @julien" })).toBeVisible();
  await expect(page.locator("span", { hasText: /^recommended$/ })).toBeVisible();

  await page.getByRole("button", { name: /no Grafana in v1/ }).click();

  await expect.poll(() => blockText(request, id)).toMatch(
    /\{\{trame:ask=@julien\}\} \{\{trame:due=2030-01-01\}\} \{\{trame:answer=no Grafana in v1\}\} \{\{trame:answered_by=[^}]+\}\} \{\{trame:completed_at=\d{4}-\d{2}-\d{2}\}\}\n```$/,
  );
  // the question and options stay as written
  expect(await blockText(request, id)).toContain("ingest port grafana-api | recommended\nno Grafana in v1\n");

  await page.reload();
  await expect(page.locator("span", { hasText: "waiting on @julien" })).toHaveCount(0);
  await expect(page.locator("span", { hasText: /^recommended$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /no Grafana in v1/ })).toBeVisible();
});
