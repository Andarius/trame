const tmp = await Deno.makeTempDir({ prefix: "trame-story-resolve-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "story-resolve-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

const { db, resolveClient, resolveStory, upsertSession } = await import("./db.ts");
const { createPage } = await import("./pages.ts");

const pageOf = async (id: string) => {
  const pg = await db();
  return (await pg.query(`select page_id from sessions where id=$1`, [id]))
    .rows[0] as { page_id: string | null };
};
const storyCount = async () => {
  const pg = await db();
  return Number(
    ((await pg.query(`select count(*) as n from pages where kind='story' and not deleted`))
      .rows[0] as { n: string | number }).n,
  );
};

// The regression this file exists for: a later track call rewording the story used to
// mint a fresh page and orphan the one the session was attached to.
Deno.test("a reworded story on a later track keeps the attached page", async () => {
  const id = await upsertSession({
    title: "repo — fix auth",
    repo_path: "/tmp/repo-a",
    branch: "fix/auth",
    story: "pg-users policy in git",
    client: "Reword Proj",
  });
  const { page_id } = await pageOf(id);
  assert(page_id, "first track attaches");
  const before = await storyCount();

  const again = await upsertSession({
    title: "repo — fix auth",
    repo_path: "/tmp/repo-a",
    branch: "fix/auth",
    story: "pg-users policy, tracked in git", // the drift that used to orphan
  });
  assertEquals(again, id);
  assertEquals((await pageOf(id)).page_id, page_id);
  assertEquals(await storyCount(), before, "no page minted by the rewording");
});

Deno.test("an explicit page_id still retargets and null still detaches", async () => {
  const clientId = await resolveClient("Retarget Proj");
  const other = await createPage({ title: "The other story", kind: "story", parent_id: clientId });
  const id = await upsertSession({
    title: "repo — retarget",
    repo_path: "/tmp/repo-b",
    branch: "main",
    story: "Original story",
  });
  await upsertSession({ id, title: "repo — retarget", page_id: other });
  assertEquals((await pageOf(id)).page_id, other, "explicit page_id wins over the attachment");
  await upsertSession({ id, title: "repo — retarget", page_id: null });
  assertEquals((await pageOf(id)).page_id, null, "explicit null detaches (the drawer)");
});

Deno.test("an update that omits page_id keeps the attachment", async () => {
  const id = await upsertSession({
    title: "repo — keep",
    repo_path: "/tmp/repo-c",
    branch: "main",
    story: "Keep me attached",
  });
  const { page_id } = await pageOf(id);
  await upsertSession({ id, title: "repo — keep (renamed)", status: "paused" });
  assertEquals((await pageOf(id)).page_id, page_id);
});

Deno.test("another project's same-titled story is not absorbed", async () => {
  const aId = await resolveClient("Proj A");
  const theirStory = await createPage({ title: "Auth cleanup", kind: "story", parent_id: aId, client_id: aId });
  const id = await upsertSession({
    title: "repo — b auth",
    repo_path: "/tmp/repo-d",
    branch: "main",
    client: "Proj B",
    story: "Auth cleanup",
  });
  const { page_id } = await pageOf(id);
  assert(page_id && page_id !== theirStory, "B gets its own story, A's is off-limits");
});

Deno.test("spelling drift resolves to the same story", async () => {
  const clientId = await resolveClient("Proj Drift");
  const first = await resolveStory("Ship the Feature", clientId);
  assertEquals(await resolveStory("  ship   the feature ", clientId), first);
});

Deno.test("an unfiled plain page is reused and promoted", async () => {
  const plain = await createPage({ title: "Loose notes" }); // client_id null
  const clientId = await resolveClient("Proj Promote");
  assertEquals(await resolveStory("loose notes", clientId), plain);
  const pg = await db();
  const row = (await pg.query(`select kind, client_id from pages where id=$1`, [plain]))
    .rows[0] as { kind: string; client_id: string | null };
  // resolveStory finds it; promotion happens on attach (upsertSession), not here
  assertEquals(row.kind, "page");
  const id = await upsertSession({
    title: "repo — promote",
    repo_path: "/tmp/repo-e",
    branch: "main",
    client: "Proj Promote",
    story: "Loose notes",
  });
  assertEquals((await pageOf(id)).page_id, plain);
  const after = (await pg.query(`select kind, client_id from pages where id=$1`, [plain]))
    .rows[0] as { kind: string; client_id: string | null };
  assertEquals(after.kind, "story");
  assertEquals(after.client_id, clientId);
});

Deno.test("a blank story attaches nothing", async () => {
  const before = await storyCount();
  const id = await upsertSession({
    title: "repo — blank",
    repo_path: "/tmp/repo-f",
    branch: "main",
    story: "   ",
  });
  assertEquals((await pageOf(id)).page_id, null);
  assertEquals(await storyCount(), before);
});
