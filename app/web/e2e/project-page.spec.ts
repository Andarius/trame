import { expect, test } from "@playwright/test";

test("project page lists user stories in progress with their open cards nested", async ({ page, request }) => {
  const mk = (title: string, status: string) =>
    request.post("/api/sessions", {
      data: { title, client: "SF Client", story: "SF Story", status, no_event: true },
    });
  for (const t of ["sf — one", "sf — two", "sf — three", "sf — four"]) await mk(t, "active");
  await mk("sf — shipped", "done");
  const pages = await (await request.get("/api/pages")).json() as { id: string; title: string; kind: string }[];
  const project = pages.find((p) => p.kind === "project" && p.title === "SF Client")!;
  await page.goto(`/?view=page&page=${project.id}`);
  await expect(page.getByText(/^IN PROGRESS/)).toBeVisible();
  // the sidebar lists the story too; the project row carries the done / total count
  await expect(page.getByRole("button").filter({ hasText: "SF Story" }).filter({ hasText: "1 / 5" })).toBeVisible();
  // open cards nest under the story (repo prefix shown as a chip), folded past three; done ones are only counted
  const card = (name: string) => page.getByText(name, { exact: true });
  await expect(card("four")).toBeVisible();
  await expect(card("one")).toHaveCount(0);
  await page.getByRole("button", { name: "▸ 1 more" }).click();
  await expect(card("one")).toBeVisible();
  await expect(card("shipped")).toHaveCount(0);
});
