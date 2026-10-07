import { expect, test } from "@playwright/test";

test("the card's Repo field links the forge repo; the local path is only a tooltip", async ({ page, request }) => {
  const id = crypto.randomUUID();
  expect((await request.post("/api/sessions", {
    data: { id, title: `Repo card ${id}`, repo_path: "/repos/acme-api", pr_url: "https://github.com/acme/acme-api/pull/3", no_event: true },
  })).ok()).toBeTruthy();

  await page.goto(`/?view=card&card=${id}`);
  const link = page.getByRole("link", { name: "acme/acme-api" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/acme-api");
  await expect(link).toHaveAttribute("title", /\/repos\/acme-api/);
  await expect(page.getByText("/repos/acme-api", { exact: true })).toHaveCount(0);
});
