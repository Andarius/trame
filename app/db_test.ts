import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = testTempDir("trame-db-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "db-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assert, assertEquals } from "@std/assert";

// One PGlite for the file: these run in order and clean up after themselves.

// Regression: two offline nodes adding the same label must converge on one column after
// sync. uniqueStatusKey resolves the key against local rows only, so both nodes land on
// "review" — the id therefore has to fall out of the key, not be random per node.
Deno.test("status ids are derived from the key, so two nodes converge", async () => {
  const { createStatus, deleteStatus, getBoard, statusId } = await import("../core/sessions.ts");

  const id = await createStatus(APP_CTX, { label: "Review", color: "#56b6c2" });
  assertEquals(id, await statusId("review"), "id is derived from the key, not random");

  // recreating a deleted key revives that row instead of colliding on the primary key
  await deleteStatus(APP_CTX, id);
  const again = await createStatus(APP_CTX, { label: "Review", color: "#7a9ee7" });
  assertEquals(again, id);
  const live = ((await getBoard(APP_CTX)).statuses as { id: string; key: string; color: string }[])
    .filter((s) => s.key === "review");
  assertEquals(live.length, 1, "one column, not two");
  assertEquals(live[0].color, "#7a9ee7"); // last write wins

  await deleteStatus(APP_CTX, again);
});

// Regression: the board columns are user-editable, but the session default, the importers
// and the tracking skills still emit fixed keys. Deleting 'active' must not strand every
// later card in a column that no longer exists.
Deno.test("a session whose status was deleted lands on a surviving column", async () => {
  const { deleteStatus, getBoard, upsertSession } = await import("../core/sessions.ts");

  const before = (await getBoard(APP_CTX)).statuses as { id: string; key: string }[];
  assertEquals(before.map((s) => s.key), ["active", "paused", "blocked", "done"]);

  await deleteStatus(APP_CTX, before.find((s) => s.key === "active")!.id);

  // no status given → the 'active' default, which no longer exists
  const id = await upsertSession(APP_CTX, { title: "orphan-status card" });

  const after = await getBoard(APP_CTX);
  const keys = (after.statuses as { key: string }[]).map((s) => s.key);
  assert(!keys.includes("active"), "active was deleted");
  const card = (after.sessions as { id: string; status: string }[]).find((s) => s.id === id)!;
  assert(keys.includes(card.status), `card landed on a live column, got "${card.status}"`);
  assertEquals(card.status, "paused"); // first surviving non-terminal
});

// One agent session ships many small PRs on one topic: they belong on one card. The
// branch-keyed lookup minted a card per branch (13 cards for one story in one session).
Deno.test("one session and story share a card across branches and repos", async () => {
  const { getBoard, setSessionStatus, upsertSession } = await import("../core/sessions.ts");
  const claude = crypto.randomUUID();
  const track = (branch: string, extra: Record<string, unknown> = {}) =>
    upsertSession(APP_CTX, {
      title: "cutover",
      claude_id: claude,
      repo_path: "/tmp/repo-a",
      branch,
      ...extra,
    });
  const card = (id: string) =>
    getBoard(APP_CTX).then((b) =>
      (b.sessions as {
        id: string;
        branch: string;
        branches: string;
        pr_url: string | null;
        status: string;
      }[])
        .find((s) => s.id === id)!
    );

  const first = await track("feat/a", {
    story: "Staging cutover",
    pr_url: "https://gh/pr/1",
  });
  const second = await track("feat/b", {
    story: "Staging cutover",
    repo_path: "/tmp/repo-b",
    pr_url: "https://gh/pr/2",
  });
  assertEquals(
    second,
    first,
    "same session + story, other branch and repo: same card",
  );
  const merged = await card(first);
  assertEquals(merged.branch, "feat/b");
  assertEquals(merged.branches, "feat/a\nfeat/b");
  assertEquals(merged.pr_url, "https://gh/pr/1\nhttps://gh/pr/2");

  assert(
    await track("feat/c", { story: "Docs sweep" }) !== first,
    "another story splits",
  );
  assert(
    await track("feat/d") !== first,
    "no story + unseen branch: the legacy per-branch card",
  );
  assertEquals(
    await track("feat/a"),
    first,
    "no story + a branch the card shipped: that card",
  );
  assert(
    await track("feat/a", { story: "Legacy teardown" }) !== first,
    "another story splits on a branch the card already shipped",
  );

  await setSessionStatus(APP_CTX, first, "done");
  assert(
    await track("feat/a", { story: "Staging cutover" }) !== first,
    "a done card is never reopened",
  );
  assertEquals((await card(first)).status, "done");
});

// Without an agent session id (MCP, manual), repo + branch still finds a card through
// any branch it shipped, not only the latest one.
Deno.test("repo + branch matches a card through an earlier branch", async () => {
  const { upsertSession } = await import("../core/sessions.ts");
  const claude = crypto.randomUUID();
  const repo = "/tmp/repo-earlier-branch";
  const id = await upsertSession(APP_CTX, {
    title: "t",
    story: "Earlier branch",
    claude_id: claude,
    repo_path: repo,
    branch: "feat/1",
  });
  await upsertSession(APP_CTX, {
    title: "t",
    story: "Earlier branch",
    claude_id: claude,
    repo_path: repo,
    branch: "feat/2",
  });
  assertEquals(
    await upsertSession(APP_CTX, { title: "manual", repo_path: repo, branch: "feat/1" }),
    id,
  );
});

// A drawer save (explicit id) sets pr_url as given, so removing a PR there sticks.
Deno.test("an explicit-id save replaces the PR list", async () => {
  const { getBoard, upsertSession } = await import("../core/sessions.ts");
  const id = await upsertSession(APP_CTX, {
    title: "t",
    repo_path: "/tmp/repo-drawer",
    branch: "b",
    pr_url: "https://gh/pr/1",
  });
  await upsertSession(APP_CTX, {
    title: "t",
    repo_path: "/tmp/repo-drawer",
    branch: "b",
    pr_url: "https://gh/pr/2",
  });
  await upsertSession(APP_CTX, {
    id,
    title: "t",
    repo_path: "/tmp/repo-drawer",
    branch: "b",
    pr_url: "https://gh/pr/2",
  });
  const s = ((await getBoard(APP_CTX)).sessions as { id: string; pr_url: string }[])
    .find((x) => x.id === id)!;
  assertEquals(s.pr_url, "https://gh/pr/2");
});

// A reworded story reuses the near-identical open one and says so.
Deno.test("a near-duplicate story name reuses the open story", async () => {
  const { getBoard, upsertSession } = await import("../core/sessions.ts");
  const out: { story_note?: string } = {};
  const a = await upsertSession(APP_CTX, {
    title: "a",
    client: "Similar",
    story: "Staging cutover (saas-ops → saas-dev)",
  });
  const b = await upsertSession(APP_CTX, {
    title: "b",
    client: "Similar",
    story: "staging cutover saas-dev",
  }, out);
  const pages = (await getBoard(APP_CTX)).sessions as {
    id: string;
    page_id: string;
  }[];
  const page = (id: string) => pages.find((s) => s.id === id)!.page_id;
  assertEquals(page(b), page(a));
  assert(out.story_note?.startsWith("matched existing story"), out.story_note);
});

Deno.test("getBoard(APP_CTX, {deleted}) returns only the soft-deleted sessions", async () => {
  const { deleteSession, getBoard, upsertSession } = await import("../core/sessions.ts");
  const gone = await upsertSession(APP_CTX, { title: "deleted card" });
  const kept = await upsertSession(APP_CTX, { title: "live card" });
  await deleteSession(APP_CTX, gone);
  const ids = async (deleted: boolean) =>
    ((await getBoard(APP_CTX, { deleted })).sessions as { id: string }[]).map((s) => s.id);
  assert((await ids(true)).includes(gone));
  assert(!(await ids(true)).includes(kept));
  assert(!(await ids(false)).includes(gone));
  await deleteSession(APP_CTX, kept);
});
