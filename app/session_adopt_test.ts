import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-session-adopt-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "session-adopt-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assert, assertEquals, assertNotEquals } from "@std/assert";

const { db } = await import("./db.ts");
const { resolveClient, resolveStory, upsertSession } = await import("../core/sessions.ts");

const row = async (id: string) => {
  const pg = await db();
  return (await pg.query(
    `select branch, page_id, status from sessions where id=$1 and not deleted`,
    [id],
  )).rows[0] as { branch: string | null; page_id: string | null; status: string };
};

// Planned work = an unbranched open card. The first track naming its story adopts it
// (card continuity: next_step, links); unrelated work on the same repo must NOT.
Deno.test("an anchored plan is adopted only by a track naming its story", async () => {
  const clientId = await resolveClient(APP_CTX, "Adopt Proj");
  const story = await resolveStory(APP_CTX, "Card sweep", clientId);
  const plan = await upsertSession(APP_CTX, {
    title: "trame — card sweep (planned)",
    status: "paused",
    client_id: clientId,
    page_id: story,
    repo_path: "/tmp/adopt-repo",
  });

  // unrelated work on the repo: new card, plan untouched
  const other = await upsertSession(APP_CTX, {
    title: "trame — unrelated fix",
    repo_path: "/tmp/adopt-repo",
    branch: "fix/unrelated",
    story: "Some other goal",
  });
  assertNotEquals(other, plan);
  assertEquals((await row(plan)).branch, null, "the plan kept its empty branch");

  // work on the plan's story: the plan becomes the card and gains the branch
  const real = await upsertSession(APP_CTX, {
    title: "trame — card sweep",
    repo_path: "/tmp/adopt-repo",
    branch: "feat/card-sweep",
    client: "Adopt Proj",
    story: "card sweep", // normalized match
  });
  assertEquals(real, plan);
  const after = await row(plan);
  assertEquals(after.branch, "feat/card-sweep");
  assertEquals(after.page_id, story, "the anchor survives adoption");
});

Deno.test("an unanchored plan is adopted by the first tracked branch", async () => {
  const plan = await upsertSession(APP_CTX, {
    title: "someday — clean this repo",
    status: "paused",
    repo_path: "/tmp/adopt-repo-2",
  });
  const real = await upsertSession(APP_CTX, {
    title: "cleanup begins",
    repo_path: "/tmp/adopt-repo-2",
    branch: "chore/cleanup",
  });
  assertEquals(real, plan);
  assertEquals((await row(plan)).branch, "chore/cleanup");
});

Deno.test("an exact-branch card wins over a plan; a done plan is never adopted", async () => {
  const clientId = await resolveClient(APP_CTX, "Adopt Proj B");
  const exact = await upsertSession(APP_CTX, {
    title: "repo — ongoing",
    repo_path: "/tmp/adopt-repo-3",
    branch: "feat/x",
  });
  await upsertSession(APP_CTX, {
    title: "repo — plan",
    status: "paused",
    repo_path: "/tmp/adopt-repo-3",
  });
  const again = await upsertSession(APP_CTX, {
    title: "repo — ongoing more",
    repo_path: "/tmp/adopt-repo-3",
    branch: "feat/x",
  });
  assertEquals(again, exact, "exact branch match is preferred");

  const doneId = await upsertSession(APP_CTX, {
    title: "repo — abandoned plan",
    status: "done",
    client_id: clientId,
    repo_path: "/tmp/adopt-repo-4",
  });
  const fresh = await upsertSession(APP_CTX, {
    title: "repo — new work",
    repo_path: "/tmp/adopt-repo-4",
    branch: "feat/y",
  });
  assertNotEquals(fresh, doneId, "a terminal card stays closed");
  assert(fresh);
});

// track --card sends no title: a partial write keeps the card's fields, null still clears
Deno.test("partial write on a known card keeps omitted fields", async () => {
  const id = await upsertSession(APP_CTX, {
    title: "partial", repo_path: "/repo/partial", branch: "feat/p", next_step: "next", summary: "sum",
  });
  await upsertSession(APP_CTX, { id, status: "active", pr_url: null });
  const pg = await db();
  const r = (await pg.query(`select title, repo_path, next_step, summary, pr_url from sessions where id=$1`, [id]))
    .rows[0];
  assertEquals(r, { title: "partial", repo_path: "/repo/partial", next_step: "next", summary: "sum", pr_url: null });
});
