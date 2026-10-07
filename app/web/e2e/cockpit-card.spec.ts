import { expect, test } from "@playwright/test";

test("a card filed in Cockpit shows a Cockpit field, not the raw mark in its specs", async ({ page, request }) => {
  await page.route("**/api/plugins/cockpit/settings", (r) => r.fulfill({ json: { baseUrl: "https://cockpit.example/" } }));
  const id = crypto.randomUUID();
  expect((await request.post("/api/sessions", { data: { id, title: `Filed card ${id}`, no_event: true } })).ok()).toBeTruthy();
  const { page_id } = await (await request.post(`/api/sessions/${id}/specs-page`)).json() as { page_id: string };
  await request.post(`/api/pages/${page_id}`, {
    data: { content: [{ id: crypto.randomUUID(), type: "text", text: "{{trame:cockpit_ref=GEN-7453}}" }] },
  });

  await page.goto(`/?view=card&card=${id}`);
  const link = page.getByRole("link", { name: /GEN-7453/ });
  await expect(link).toHaveAttribute("href", "https://cockpit.example/ticket/GEN-7453");
  // the mark lives on in the block's off-screen editor, never in the rendered text
  await expect.poll(() => page.locator("main").evaluate((m) => (m as HTMLElement).innerText)).not.toContain("cockpit_ref");
});
