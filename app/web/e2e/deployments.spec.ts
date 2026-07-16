import { expect, test } from "@playwright/test";

// Deployments plugin against the fixture backend (TRACKER_DEPLOYMENTS_FIXTURE):
// enable via the plugins manager → nav entry + badge → org-tab panel → disable re-gates.
test.describe.configure({ mode: "serial" });

test("disabled plugin: no nav entry, API gated", async ({ page }) => {
  const r = await page.request.get("/api/plugins/deployments/state");
  expect(r.status()).toBe(403);
  await page.goto("/");
  await expect(page.getByText("Trame", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Deployments/ })).toHaveCount(
    0,
  );
});

test("plugins manager enables the plugin", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: /Manage plugins/ }).click();
  // master-detail modal: deployments pre-selected, settings form visible
  await expect(page.getByText("Watched repositories")).toBeVisible();
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  // nav picks the manifest up on the next refresh poll
  await expect(page.getByRole("button", { name: /Deployments/ })).toBeVisible();
});

test("panel lists fixture deployments under org tabs", async ({ page }) => {
  await page.request.post("/api/plugins/deployments/refresh");
  await page.goto("/?view=plugin&plugin=deployments");
  // org tabs: All + acme (all fixture repos are acme/*)
  await expect(page.getByRole("button", { name: /^All 5$/ })).toBeVisible();
  await page.getByRole("button", { name: /^acme 5$/ }).click();
  await expect(page.getByText("Deploy 2.4.0 — checkout revamp")).toBeVisible();
  await expect(page.getByText("release: v1.8.2")).toBeVisible();
  await expect(page.getByText("acme/billing")).toBeVisible();
  // in-progress and failed deployments are tracked too, not just approvals
  await expect(page.getByText(/deploying · /)).toBeVisible();
  await expect(page.getByText("✕ failed")).toBeVisible();
  await expect(page.getByText(/polled/)).toBeVisible();
  // nav badge = fixture item count
  await expect(page.getByRole("button", { name: /Deployments/ }).getByText("5"))
    .toBeVisible();
});

test("refresh button re-polls", async ({ page }) => {
  await page.goto("/?view=plugin&plugin=deployments");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/polled/)).toBeVisible();
});

test("deploy button approves after a confirm click", async ({ page }) => {
  await page.request.post("/api/plugins/deployments/refresh");
  await page.goto("/?view=plugin&plugin=deployments");
  // only the 3 waiting items carry a deploy button (running/failed don't)
  await expect(page.getByRole("button", { name: "▶ deploy" })).toHaveCount(3);
  // first click arms, second fires — fixture mode just drops the item
  await page.getByRole("button", { name: "▶ deploy" }).first().click();
  await page.getByRole("button", { name: "confirm?" }).click();
  await expect(page.getByRole("button", { name: "▶ deploy" })).toHaveCount(2);
  const state = await (
    await page.request.get("/api/plugins/deployments/state")
  ).json();
  expect(state.items).toHaveLength(4);
});

test("connection test endpoint reachable while configuring", async ({ page }) => {
  // ungated route: must answer (not 403) even for a disabled plugin
  const r = await page.request.post("/api/plugins/deployments/test", {
    data: { forge: "github", githubToken: "bogus" },
  });
  expect(r.status()).toBe(200);
});

test("gitlab token is redacted and bound to its saved host (no CSRF exfil)", async ({ page }) => {
  const settings = "/api/plugins/deployments/settings";
  const post = (data: Record<string, unknown>) => page.request.post(settings, { data });

  // save a PAT for a specific host
  let s = await (await post({ gitlabBaseUrl: "https://gl.example.com", gitlabToken: "secret-glpat" })).json();
  expect(s.gitlabHasToken).toBe(true);
  expect(JSON.stringify(s)).not.toContain("secret-glpat"); // never echoed back to the UI

  // GET also redacts to a boolean
  s = await (await page.request.get(settings)).json();
  expect(s).toMatchObject({ gitlabHasToken: true, gitlabBaseUrl: "https://gl.example.com" });
  expect(JSON.stringify(s)).not.toContain("secret-glpat");

  // pointing the base URL at another host WITHOUT re-supplying the token drops it,
  // so the background poller can never send the saved PAT to an unsaved host
  s = await (await post({ gitlabBaseUrl: "https://attacker.example.com" })).json();
  expect(s.gitlabHasToken).toBe(false);
});

test("disabling removes the nav entry and re-gates the API", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: /Manage plugins/ }).click();
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Deployments/ })).toHaveCount(
    0,
  );
  const r = await page.request.get("/api/plugins/deployments/state");
  expect(r.status()).toBe(403);
});
