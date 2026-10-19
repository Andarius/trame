import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = testTempDir("trame-db-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "db-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


// One PGlite for the file: these run in order and clean up after themselves.

// Regression: two offline nodes adding the same label must converge on one column after
// sync. uniqueStatusKey resolves the key against local rows only, so both nodes land on
// "review" — the id therefore has to fall out of the key, not be random per node.
test("status ids are derived from the key, so two nodes converge", async () => {
  const { createStatus, deleteStatus, getBoard, statusId } = await import("../core/sessions.ts");

  const id = await createStatus(APP_CTX, { label: "Review", color: "#56b6c2" });
  expect(id, "id is derived from the key, not random").toStrictEqual(await statusId("review"));

  // recreating a deleted key revives that row instead of colliding on the primary key
  await deleteStatus(APP_CTX, id);
  const again = await createStatus(APP_CTX, { label: "Review", color: "#7a9ee7" });
  expect(again).toStrictEqual(id);
  const live = ((await getBoard(APP_CTX)).statuses as { id: string; key: string; color: string }[])
    .filter((s) => s.key === "review");
  expect(live.length, "one column, not two").toStrictEqual(1);
  expect(live[0].color).toStrictEqual("#7a9ee7"); // last write wins

  await deleteStatus(APP_CTX, again);
});

// Regression: the board columns are user-editable, but the session default, the importers
// and the tracking skills still emit fixed keys. Deleting 'active' must not strand every
// later card in a column that no longer exists.
test("a session whose status was deleted lands on a surviving column", async () => {
  const { deleteStatus, getBoard, upsertSession } = await import("../core/sessions.ts");

  const before = (await getBoard(APP_CTX)).statuses as { id: string; key: string }[];
  expect(before.map((s) => s.key)).toStrictEqual(["todo", "active", "paused", "blocked", "done"]);

  await deleteStatus(APP_CTX, before.find((s) => s.key === "active")!.id);

  // no status given → the 'active' default, which no longer exists
  const id = await upsertSession(APP_CTX, { title: "orphan-status card" });

  const after = await getBoard(APP_CTX);
  const keys = (after.statuses as { key: string }[]).map((s) => s.key);
  expect(!keys.includes("active"), "active was deleted").toBeTruthy();
  const card = (after.sessions as { id: string; status: string }[]).find((s) => s.id === id)!;
  expect(keys.includes(card.status), `card landed on a live column, got "${card.status}"`).toBeTruthy();
  expect(card.status).toStrictEqual("todo"); // first surviving non-terminal
});

// One agent session ships many small PRs on one topic: they belong on one card. The
// branch-keyed lookup minted a card per branch (13 cards for one story in one session).
test("one session and story share a card across branches and repos", async () => {
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
  expect(second, "same session + story, other branch and repo: same card").toStrictEqual(first);
  const merged = await card(first);
  expect(merged.branch).toStrictEqual("feat/b");
  expect(merged.branches).toStrictEqual("feat/a\nfeat/b");
  expect(merged.pr_url).toStrictEqual("https://gh/pr/1\nhttps://gh/pr/2");

  expect(await track("feat/c", { story: "Docs sweep" }) !== first, "another story splits").toBeTruthy();
  expect(await track("feat/d") !== first, "no story + unseen branch: the legacy per-branch card").toBeTruthy();
  expect(await track("feat/a"), "no story + a branch the card shipped: that card").toStrictEqual(first);
  expect(await track("feat/a", { story: "Legacy teardown" }) !== first, "another story splits on a branch the card already shipped").toBeTruthy();

  await setSessionStatus(APP_CTX, first, "done");
  expect(await track("feat/a", { story: "Staging cutover" }) !== first, "a done card is never reopened").toBeTruthy();
  expect((await card(first)).status).toStrictEqual("done");
});

// Regression: a story nested under another story anchors its cards to the outer one, so
// the lookup by the named story missed and every track minted a card (11 in one night).
test("a nested story still shares one card across branches", async () => {
  const { upsertSession } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");
  const claude = crypto.randomUUID();
  await upsertSession(APP_CTX, { title: "outer", client: "Nested", story: "Nouvelle infra" });
  const { getBoard } = await import("../core/sessions.ts");
  const outer = ((await getBoard(APP_CTX)).sessions as { title: string; page_id: string }[])
    .find((s) => s.title === "outer")!.page_id;
  // a tracker mirror nests US stories under the user's story; createPage refuses it
  const inner = await createPage(APP_CTX, { title: "GEN-1 — Prod cut-over", kind: "story", status: "open" });
  await APP_CTX.q.query(`update pages set parent_id=$2, client_id=(select client_id from pages where id=$2) where id=$1`, [
    inner,
    outer,
  ]);
  const track = (branch: string) =>
    upsertSession(APP_CTX, {
      title: "follow-ups",
      client: "Nested",
      story: "GEN-1 — Prod cut-over",
      claude_id: claude,
      repo_path: `/tmp/wt-${branch}`,
      branch,
    });
  expect(await track("chore/a")).toStrictEqual(await track("chore/b"));
});

// Without an agent session id (MCP, manual), repo + branch still finds a card through
// any branch it shipped, not only the latest one.
test("repo + branch matches a card through an earlier branch", async () => {
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
  expect(await upsertSession(APP_CTX, { title: "manual", repo_path: repo, branch: "feat/1" })).toStrictEqual(id);
});

// A drawer save (explicit id) sets pr_url as given, so removing a PR there sticks.
test("an explicit-id save replaces the PR list", async () => {
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
  expect(s.pr_url).toStrictEqual("https://gh/pr/2");
});

// A reworded story reuses the near-identical open one and says so.
test("a near-duplicate story name reuses the open story", async () => {
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
  expect(page(b)).toStrictEqual(page(a));
  expect(out.story_note?.startsWith("matched existing story"), out.story_note).toBeTruthy();
});

test("getBoard(APP_CTX, {deleted}) returns only the soft-deleted sessions", async () => {
  const { deleteSession, getBoard, upsertSession } = await import("../core/sessions.ts");
  const gone = await upsertSession(APP_CTX, { title: "deleted card" });
  const kept = await upsertSession(APP_CTX, { title: "live card" });
  await deleteSession(APP_CTX, gone);
  const ids = async (deleted: boolean) =>
    ((await getBoard(APP_CTX, { deleted })).sessions as { id: string }[]).map((s) => s.id);
  expect((await ids(true)).includes(gone)).toBeTruthy();
  expect(!(await ids(true)).includes(kept)).toBeTruthy();
  expect(!(await ids(false)).includes(gone)).toBeTruthy();
  await deleteSession(APP_CTX, kept);
});
