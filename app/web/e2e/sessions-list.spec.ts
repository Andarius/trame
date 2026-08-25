import { type APIRequestContext, expect, test } from "@playwright/test";

// Sessions list view: the project pill filters its sessions on click, and
// double-clicking a row opens the drawer already expanded to full screen.
test.describe.configure({ mode: "serial" });

const PAGE_TITLES = ["Chip Proj", "Chip Story", "Chip Proj B"];
const SESSION_TITLES = [
  "chip session e2e",
  "other session e2e",
  "beta session e2e",
];

const seed = async (request: APIRequestContext) => {
  // retry-safe: wipe leftovers from a previous run
  const pages = await (await request.get("/api/pages")).json() as {
    id: string;
    title: string;
  }[];
  for (const p of pages.filter((x) => PAGE_TITLES.includes(x.title))) {
    await request.post(`/api/pages/${p.id}/delete`, { data: {} });
  }
  const board = await (await request.get("/api/board")).json() as {
    sessions: { id: string; title: string }[];
  };
  for (const s of board.sessions.filter((x) => SESSION_TITLES.includes(x.title))) {
    await request.post(`/api/sessions/${s.id}/delete`, { data: {} });
  }

  const proj = await (await request.post("/api/pages", {
    data: { title: "Chip Proj", kind: "project" },
  })).json() as { id: string };
  await request.post("/api/pages", {
    data: { title: "Chip Story", kind: "page", parent_id: proj.id },
  });
  await request.post("/api/sessions", {
    data: {
      title: "chip session e2e",
      objective: "Chip Story",
      no_event: true,
      repo_path: "/tmp/chip-e2e",
    },
  });
  await request.post("/api/sessions", {
    data: {
      title: "other session e2e",
      no_event: true,
      repo_path: "/tmp/other-e2e",
    },
  });
  // objective creates the "Chip Proj B" story page itself
  await request.post("/api/sessions", {
    data: {
      title: "beta session e2e",
      objective: "Chip Proj B",
      no_event: true,
      repo_path: "/tmp/beta-e2e",
    },
  });
};

test("project pill click filters the list to that project", async ({ page, request }) => {
  await seed(request);
  await page.goto("/?view=list");
  await expect(page.getByText("chip session e2e")).toBeVisible();
  await expect(page.getByText("other session e2e")).toBeVisible();

  await page.getByTitle("Show only “Chip Proj”").click();
  await expect(page.getByText("other session e2e")).not.toBeVisible();
  await expect(page.getByText("beta session e2e")).not.toBeVisible();
  await expect(page.getByText("chip session e2e")).toBeVisible();

  // focusing the empty input already suggests projects/stories
  await page.getByPlaceholder("＋ filter…").click();
  await expect(
    page.getByRole("main").getByRole("button", { name: "Chip Proj B" }),
  ).toBeVisible();

  // the autocomplete adds a second project — sessions shown are the union
  await page.getByPlaceholder("＋ filter…").fill("chip proj b");
  await page.getByRole("main").getByRole("button", { name: "Chip Proj B" })
    .click();
  await expect(page.getByText("beta session e2e")).toBeVisible();
  await expect(page.getByText("chip session e2e")).toBeVisible();
  await expect(page.getByText("other session e2e")).not.toBeVisible();

  // "clear" drops every filter at once
  await page.getByTitle("Clear all filters").click();
  await expect(page.getByText("other session e2e")).toBeVisible();

  // pill toggle still works standalone: on, then off
  await page.getByTitle("Show only “Chip Proj”").click();
  await expect(page.getByText("other session e2e")).not.toBeVisible();
  await page.getByTitle("Show only “Chip Proj”").click();
  await expect(page.getByText("other session e2e")).toBeVisible();
});

test("double-click opens the drawer full screen; single click stays a side panel", async ({ page, request }) => {
  await seed(request);
  await page.goto("/?view=list");

  await page.getByText("other session e2e").click();
  await expect(page.getByTitle("expand to full screen")).toBeVisible();
  await page.getByTitle("expand to full screen").press("Escape");
  await expect(page.getByTitle("expand to full screen")).not.toBeVisible();

  await page.getByText("chip session e2e").dblclick();
  await expect(page.getByTitle("collapse to side panel")).toBeVisible();

  // full-screen survives a refresh (&full=1 in the URL)
  await page.reload();
  await expect(page.getByTitle("collapse to side panel")).toBeVisible();
});

test("double-click on a board card opens the drawer full screen", async ({ page, request }) => {
  await seed(request);
  await page.goto("/?view=board");
  await page.getByText("other session e2e").dblclick();
  await expect(page.getByTitle("collapse to side panel")).toBeVisible();
});

test("expanded ticket: journal pane and editable persistent specs", async ({ page, request }) => {
  await seed(request);
  await page.goto("/?view=list");
  await page.getByText("chip session e2e").dblclick();
  // ticket layout: journal pane with the composer, specs placeholder on the left
  await expect(page.getByText("JOURNAL", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Log what happened/)).toBeVisible();

  await page.getByRole("button", { name: /add specs/ }).click();
  await page.keyboard.type("first spec item\n- second spec item");
  await page.getByText("SPECS", { exact: true }).click(); // blur commits
  await expect(page.getByText("first spec item")).toBeVisible();
  await expect(page.getByText("second spec item")).toBeVisible();

  // survives a reload — the URL restores the drawer already full screen
  await page.reload();
  await expect(page.getByText("second spec item")).toBeVisible();
});
