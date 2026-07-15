import { expect, test } from "@playwright/test";

// Database views: multi-column sort + filtering over a database, and the regression
// guard that the row detail panel resolves against the full row set (a row added
// while a filter is active must still open, even though the filter hides it).
test.describe.configure({ mode: "serial" });

const DB = "Views DB";

// build a fresh db with a title column and three rows via the API (fast + deterministic)
test.beforeAll(async ({ request }) => {
  for (
    const d of (await (await request.get("/api/udb")).json() as {
      id: string;
      name: string;
    }[])
  ) {
    if (d.name === DB) {
      await request.post(`/api/udb/${d.id}/delete`, { data: {} });
    }
  }
  const { id } = await (await request.post("/api/udb", { data: { name: DB } }))
    .json();
  const { properties } = await (await request.get(`/api/udb/${id}`)).json();
  const titleId = properties.find((p: { type: string }) =>
    p.type === "title"
  ).id;
  for (const t of ["cherry", "apple", "banana"]) {
    await request.post(`/api/udb/${id}/rows`, {
      data: { vals: { [titleId]: t } },
    });
  }
});

test.afterAll(async ({ request }) => {
  for (
    const d of (await (await request.get("/api/udb")).json() as {
      id: string;
      name: string;
    }[])
  ) {
    if (d.name === DB) {
      await request.post(`/api/udb/${d.id}/delete`, { data: {} });
    }
  }
});

test("sorting the title column orders the rows", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: DB }).click();
  // click the Name column's sort caret (cycles off → asc)
  const nameHeader = page.locator("main .group").filter({
    has: page.getByRole("button", { name: /Name/ }),
  }).first();
  await nameHeader.getByTitle(/sort by this column|cycle sort/).click();
  await expect(page.getByText("3 of 3")).toBeVisible();
  // ascending → apple first, cherry last
  await expect(page.locator("main div.group.grid input").first()).toHaveValue(
    "apple",
  );
});

test("filtering hides non-matching rows and shows the count", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: DB }).click();
  await page.getByRole("button", { name: /Filter/ }).click();
  await page.getByRole("button", { name: "＋ Add filter" }).click();
  // default rule is Name · contains · "" (a no-op); narrow it to "apple"
  await page.getByPlaceholder("value…").fill("apple");
  await expect(page.getByText("1 of 3")).toBeVisible();
  await page.keyboard.press("Escape"); // close the filter popover
  await expect(page.locator("main div.group.grid input").first()).toHaveValue(
    "apple",
  );
});

test("a row added under an active filter still opens in the panel (regression)", async ({ page }) => {
  await page.goto("/?view=database");
  await page.getByRole("button", { name: DB }).click();
  // re-apply the "contains apple" filter
  await page.getByRole("button", { name: /Filter/ }).click();
  await page.getByRole("button", { name: "＋ Add filter" }).click();
  await page.getByPlaceholder("value…").fill("apple");
  await expect(page.getByText("1 of 3")).toBeVisible();
  await page.keyboard.press("Escape");

  // add a blank row — it can't match "contains apple", so it's hidden from the grid…
  await page.getByRole("button", { name: "＋ New row" }).nth(1).click();
  // …but the detail panel must still open for it (resolved from data.rows, not the view)
  await expect(page.getByText("auto-saves")).toBeVisible();
  await expect(page.locator("textarea").first()).toBeVisible();
  // the blank row grew the total but stays filtered out of the grid (1 match of 4)
  await expect(page.getByText("1 of 4")).toBeVisible();
  await page.keyboard.press("Escape");
});

// View tabs persist server-side (udb_databases.views), so they sync across devices instead
// of living only in one browser's localStorage.
async function dbId(
  request: import("@playwright/test").APIRequestContext,
): Promise<string> {
  const dbs = await (await request.get("/api/udb")).json() as {
    id: string;
    name: string;
  }[];
  return dbs.find((d) => d.name === DB)!.id;
}

test("a view saved on the hub is adopted by a fresh browser (no localStorage)", async ({ page, request }) => {
  const id = await dbId(request);
  // another device saves a named view via the API
  const views = {
    tabs: [{
      id: "srv-1",
      name: "By model",
      config: { sorts: [], filters: [] },
    }],
    active: "srv-1",
  };
  await request.post(`/api/udb/${id}`, { data: { views } });
  // the hub round-trips it back on read
  expect((await (await request.get(`/api/udb/${id}`)).json()).db.views)
    .toMatchObject(views);

  // this browser has never seen the db — wipe localStorage, then open it
  await page.goto("/?view=database");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: DB }).click();
  // the tab comes from the hub, not localStorage
  await expect(page.getByRole("button", { name: "By model" })).toBeVisible();
});

test("a view edited in the UI is written back to the hub", async ({ page, request }) => {
  const id = await dbId(request);
  // reset server + local state so the write we assert is the one this test makes
  await request.post(`/api/udb/${id}`, { data: { views: [] } });
  await page.goto("/?view=database");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: DB }).click();

  // sorting the Name column mutates the active view → debounced write-through to the hub
  // (row count is shared/mutated by earlier tests, so assert on the sort indicator, not a count)
  const nameHeader = page.locator("main .group").filter({
    has: page.getByRole("button", { name: /Name/ }),
  }).first();
  await nameHeader.getByTitle(/sort by this column|cycle sort/).click();
  await expect(page.getByRole("button", { name: /Sort · 1/ })).toBeVisible();

  // the hub now carries the sort (poll past the 500ms debounce)
  await expect.poll(async () => {
    const v = (await (await request.get(`/api/udb/${id}`)).json()).db.views as {
      tabs?: { config: { sorts: unknown[] } }[];
    };
    return v?.tabs?.[0]?.config?.sorts?.length ?? 0;
  }).toBe(1);
});

test("a summary view is a read-only aggregate table (one row per group, live like a DB view)", async ({ page, request }) => {
  // dedicated db: a title + a number column, two rows sharing group A (avg 15) and one in B (avg 30)
  const { id } =
    await (await request.post("/api/udb", { data: { name: "Summary DB" } }))
      .json();
  const titleId = (await (await request.get(`/api/udb/${id}`)).json())
    .properties.find((p: { type: string }) => p.type === "title").id;
  const ptsId = (await (await request.post(`/api/udb/${id}/props`, {
    data: { name: "Pts", type: "number" },
  })).json()).id;
  for (const [t, n] of [["A", 10], ["A", 20], ["B", 30]] as const) {
    await request.post(`/api/udb/${id}/rows`, {
      data: { vals: { [titleId]: t, [ptsId]: n } },
    });
  }
  // save the grouped summary view on the hub: group by title, avg Pts, summary on
  const config = {
    sorts: [],
    filters: [],
    groupBy: titleId,
    summary: true,
    aggs: { [ptsId]: "avg" },
  };
  await request.post(`/api/udb/${id}`, {
    data: {
      views: {
        tabs: [{ id: "sum-1", name: "By team", config }],
        active: "sum-1",
      },
    },
  });

  await page.goto("/?view=database");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Summary DB" }).click();
  await expect(page.getByRole("button", { name: "By team" })).toBeVisible();

  // aggregate columns + one computed row per group (A: avg 15, B: avg 30)
  await expect(page.getByText("Count")).toBeVisible();
  await expect(page.getByText("15", { exact: true })).toBeVisible();
  await expect(page.getByText("30", { exact: true })).toBeVisible();

  // not modifiable: group labels are text, not editable cells, and there's no add-row affordance
  await expect(page.locator('main input[value="A"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ New row" })).toHaveCount(0);

  await request.post(`/api/udb/${id}/delete`, { data: {} });
});

test("the ＋ menu creates a Summary view (aggregate-only)", async ({ page, request }) => {
  const { id } =
    await (await request.post("/api/udb", { data: { name: "SumMenu DB" } }))
      .json();
  const titleId = (await (await request.get(`/api/udb/${id}`)).json())
    .properties.find((p: { type: string }) => p.type === "title").id;
  const ptsId = (await (await request.post(`/api/udb/${id}/props`, {
    data: { name: "Pts", type: "number" },
  })).json()).id;
  for (const [t, n] of [["A", 10], ["A", 20], ["B", 30]] as const) {
    await request.post(`/api/udb/${id}/rows`, {
      data: { vals: { [titleId]: t, [ptsId]: n } },
    });
  }
  await page.goto("/?view=database");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "SumMenu DB" }).click();

  // open the new-view menu → choose "Summary view"; groupBy defaults to the first non-title prop (Pts)
  await page.getByTitle("new view").click();
  await page.getByRole("button", { name: /Summary view/ }).click();
  await expect(page.getByRole("button", { name: /Summary/ })).toBeVisible();
  // aggregate-only table: a Count column, and no editable title cells / add-row
  await expect(page.getByText("Count")).toBeVisible();
  await expect(page.locator('main input[value="A"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ New row" })).toHaveCount(0);

  await request.post(`/api/udb/${id}/delete`, { data: {} });
});

test("grouped grid shows whole-group counts under pagination", async ({ page, request }) => {
  const { id } =
    await (await request.post("/api/udb", { data: { name: "PageGrp DB" } }))
      .json();
  const titleId = (await (await request.get(`/api/udb/${id}`)).json())
    .properties.find((p: { type: string }) => p.type === "title").id;
  const teamId = (await (await request.post(`/api/udb/${id}/props`, {
    data: { name: "Team", type: "text" },
  })).json()).id;
  // 30 rows, all in one group — more than the 25-row page size we set below
  for (let i = 0; i < 30; i++) {
    await request.post(`/api/udb/${id}/rows`, {
      data: { vals: { [titleId]: `r${i}`, [teamId]: "A" } },
    });
  }
  // grouped (non-summary) Table view, grouped by Team
  const config = { sorts: [], filters: [], groupBy: teamId };
  await request.post(`/api/udb/${id}`, {
    data: {
      views: { tabs: [{ id: "t1", name: "Table", config }], active: "t1" },
    },
  });

  await page.goto("/?view=database");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("trame:udbpagesize", "25");
  });
  await page.reload();
  await page.getByRole("button", { name: "PageGrp DB" }).click();

  // the page renders 25 rows, but the group header count is the WHOLE group (30), not the page slice
  await expect(page.locator("main div.group.grid")).toHaveCount(25);
  await expect(page.locator("main").getByText("30", { exact: true }))
    .toBeVisible();

  await request.post(`/api/udb/${id}/delete`, { data: {} });
});
