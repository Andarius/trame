import { describe, expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-story-resolve-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "story-resolve-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


const { db } = await import("./db.ts");
const { ensureSessionLink, linksForSession, resolveClient, resolveStory, sessionFromPage, storyFromPage, upsertSession } =
  await import(
  "../core/sessions.ts"
);
const { createPage } = await import("../core/pages.ts");

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
test("a reworded story on a later track keeps the attached page", async () => {
  const id = await upsertSession(APP_CTX, {
    title: "repo — fix auth",
    repo_path: "/tmp/repo-a",
    branch: "fix/auth",
    story: "pg-users policy in git",
    client: "Reword Proj",
  });
  const { page_id } = await pageOf(id);
  expect(page_id, "first track attaches").toBeTruthy();
  const before = await storyCount();

  const again = await upsertSession(APP_CTX, {
    title: "repo — fix auth",
    repo_path: "/tmp/repo-a",
    branch: "fix/auth",
    story: "pg-users policy, tracked in git", // the drift that used to orphan
  });
  expect(again).toStrictEqual(id);
  expect((await pageOf(id)).page_id).toStrictEqual(page_id);
  expect(await storyCount(), "no page minted by the rewording").toStrictEqual(before);
});

test("an explicit page_id still retargets and null still detaches", async () => {
  const clientId = await resolveClient(APP_CTX, "Retarget Proj");
  const other = await createPage(APP_CTX, { title: "The other story", kind: "story", parent_id: clientId });
  const id = await upsertSession(APP_CTX, {
    title: "repo — retarget",
    repo_path: "/tmp/repo-b",
    branch: "main",
    story: "Original story",
  });
  await upsertSession(APP_CTX, { id, title: "repo — retarget", page_id: other });
  expect((await pageOf(id)).page_id, "explicit page_id wins over the attachment").toStrictEqual(other);
  await upsertSession(APP_CTX, { id, title: "repo — retarget", page_id: null });
  expect((await pageOf(id)).page_id, "explicit null detaches (the drawer)").toStrictEqual(null);
});

test("an update that omits page_id keeps the attachment", async () => {
  const id = await upsertSession(APP_CTX, {
    title: "repo — keep",
    repo_path: "/tmp/repo-c",
    branch: "main",
    story: "Keep me attached",
  });
  const { page_id } = await pageOf(id);
  await upsertSession(APP_CTX, { id, title: "repo — keep (renamed)", status: "paused" });
  expect((await pageOf(id)).page_id).toStrictEqual(page_id);
});

test("another project's same-titled story is not absorbed", async () => {
  const aId = await resolveClient(APP_CTX, "Proj A");
  const theirStory = await createPage(APP_CTX, { title: "Auth cleanup", kind: "story", parent_id: aId, client_id: aId });
  const id = await upsertSession(APP_CTX, {
    title: "repo — b auth",
    repo_path: "/tmp/repo-d",
    branch: "main",
    client: "Proj B",
    story: "Auth cleanup",
  });
  const { page_id } = await pageOf(id);
  expect(page_id && page_id !== theirStory, "B gets its own story, A's is off-limits").toBeTruthy();
});

// regression: a track with no project minted root stories that the sidebar listed as projects
{
  const home = await resolveClient(APP_CTX, "Proj Home");
  await upsertSession(APP_CTX, { title: "home repo", status: "active", client_id: home, repo_path: "/tmp/repo-home" });
  const other = await resolveClient(APP_CTX, "Proj Other");
  const theirs = await createPage(APP_CTX, { title: "Shared topic", kind: "story", parent_id: other, client_id: other });
  const pg = await db();
  describe("a track with no project files its story and card under a project", () => {
    for (
      const [id, extra, story, parent, client] of [
        ["new story goes to the repo's home project", {}, "Fresh home topic", home, home],
        ["a story elsewhere is reused, card follows it", {}, "Shared topic", other, other],
        ["explicit null project opts out", { client_id: null }, "Rootless topic", null, null],
      ] as const
    ) {
      test(id, async () => {
        const sid = await upsertSession(APP_CTX, {
          title: `home — ${story}`,
          repo_path: "/tmp/repo-home/wt",
          branch: id.replaceAll(" ", "-"),
          story,
          ...extra,
        });
        const row = (await pg.query(
          `select s.client_id, p.parent_id, p.id as page from sessions s join pages p on p.id = s.page_id where s.id=$1`,
          [sid],
        )).rows[0] as { client_id: string | null; parent_id: string | null; page: string };
        expect([row.parent_id, row.client_id]).toStrictEqual([parent, client]);
        if (story === "Shared topic") expect(row.page).toStrictEqual(theirs);
      });
    }

  });
}

test("spelling drift resolves to the same story", async () => {
  const clientId = await resolveClient(APP_CTX, "Proj Drift");
  const first = await resolveStory(APP_CTX, "Ship the Feature", clientId);
  expect(await resolveStory(APP_CTX, "  ship   the feature ", clientId)).toStrictEqual(first);
});

test("an unfiled plain page is reused and promoted", async () => {
  const plain = await createPage(APP_CTX, { title: "Loose notes" }); // client_id null
  const clientId = await resolveClient(APP_CTX, "Proj Promote");
  expect(await resolveStory(APP_CTX, "loose notes", clientId)).toStrictEqual(plain);
  const pg = await db();
  const row = (await pg.query(`select kind, client_id from pages where id=$1`, [plain]))
    .rows[0] as { kind: string; client_id: string | null };
  // resolveStory finds it; promotion happens on attach (upsertSession), not here
  expect(row.kind).toStrictEqual("page");
  const id = await upsertSession(APP_CTX, {
    title: "repo — promote",
    repo_path: "/tmp/repo-e",
    branch: "main",
    client: "Proj Promote",
    story: "Loose notes",
  });
  expect((await pageOf(id)).page_id).toStrictEqual(plain);
  const after = (await pg.query(`select kind, client_id from pages where id=$1`, [plain]))
    .rows[0] as { kind: string; client_id: string | null };
  expect(after.kind).toStrictEqual("story");
  expect(after.client_id).toStrictEqual(clientId);
});

// regression: tracking under a sub-page's title silently turned that page into a story
test("a nested plain page is never promoted by name", async () => {
  const parent = await createPage(APP_CTX, { title: "Features hub" });
  const nested = await createPage(APP_CTX, { title: "Presence demo", parent_id: parent });
  const out: { story_note?: string } = {};
  const id = await upsertSession(APP_CTX, {
    title: "repo — nested",
    repo_path: "/tmp/repo-n",
    branch: "main",
    client: "Proj Nested",
    story: "Presence demo",
  }, out);
  const pg = await db();
  const page = (await pg.query(`select kind, parent_id from pages where id=$1`, [nested]))
    .rows[0] as { kind: string; parent_id: string };
  expect([page.kind, page.parent_id]).toStrictEqual(["page", parent]);
  expect((await pageOf(id)).page_id !== nested, "the card gets its own story").toBeTruthy();
  expect(out.story_note?.includes(nested), "the reply points at the page").toBeTruthy();
});

test("a blank story attaches nothing", async () => {
  const before = await storyCount();
  const id = await upsertSession(APP_CTX, {
    title: "repo — blank",
    repo_path: "/tmp/repo-f",
    branch: "main",
    story: "   ",
  });
  expect((await pageOf(id)).page_id).toStrictEqual(null);
  expect(await storyCount()).toStrictEqual(before);
});

// regression: a block id reused on another page (copied content) was taken as already linked
{
  const id = await upsertSession(APP_CTX, { title: "repo — links", repo_path: "/tmp/repo-l", branch: "main" });
  const a = await createPage(APP_CTX, { title: "Links A" });
  const b = await createPage(APP_CTX, { title: "Links B" });
  describe("ensureSessionLink links once per page + block", () => {
    for (
      const [step, page, expected] of [
        ["first link", a, 1],
        ["same page + block again", a, 1],
        ["same block id on another page", b, 2],
      ] as const
    ) {
      test(step, async () => {
        await ensureSessionLink(APP_CTX, id, page, "blk00001", "todo");
        expect((await linksForSession(APP_CTX, id)).length).toStrictEqual(expected);
      });
    }

  });
}

{
  const project = await resolveClient(APP_CTX, "Proj Convert");
  const folder = await createPage(APP_CTX, { title: "Docs", parent_id: project });
  const plain = await createPage(APP_CTX, { title: "Becomes a story", parent_id: folder });
  const story = await createPage(APP_CTX, { title: "Existing US", kind: "story", parent_id: project });
  const underStory = await createPage(APP_CTX, { title: "Doc under a US", parent_id: story });
  const spec = await createPage(APP_CTX, { title: "Spec of a card", parent_id: project });
  await sessionFromPage(APP_CTX, spec);
  const parentOfStory = await createPage(APP_CTX, { title: "Holds a US", parent_id: project });
  await createPage(APP_CTX, { title: "Nested US", kind: "story", parent_id: parentOfStory });
  const loose = await createPage(APP_CTX, { title: "No project" });
  describe("storyFromPage converts on purpose and refuses to nest", () => {
    for (
      const [id, page, error] of [
        ["plain page under a folder", plain, null],
        ["already a story is a no-op", story, null],
        ["under a user story", underStory, "already under a user story"],
        ["a card's spec page", spec, "card's specs"],
        ["a user story below it", parentOfStory, "sits below this page"],
        ["no project to file it under", loose, "under a project first"],
      ] as const
    ) {
      test(id, async () => {
        if (error) {
          await expect(storyFromPage(APP_CTX, page)).rejects.toThrow(error);
          return;
        }
        await storyFromPage(APP_CTX, page);
        const pg = await db();
        const row = (await pg.query(`select kind, parent_id from pages where id=$1`, [page])).rows[0] as {
          kind: string;
          parent_id: string;
        };
        expect([row.kind, row.parent_id]).toStrictEqual(["story", project]);
      });
    }

  });
}

{
  const { journalPresence, touchAgentPresence } = await import("../core/agent-presence.ts");
  const pg = await db();
  const card = async (slug: string, status: string) =>
    await upsertSession(APP_CTX, { title: `repo — ${slug}`, status, repo_path: `/tmp/repo-${slug}`, branch: "main" });
  const journal = async (id: string) =>
    ((await pg.query(`select summary from session_events where session_id=$1 and kind='presence' order by at, id`, [id]))
      .rows as { summary: string }[]).map((r) => r.summary.split(" ·")[0]);
  const status = async (id: string) =>
    ((await pg.query(`select status from sessions where id=$1`, [id])).rows[0] as { status: string }).status;
  describe("journalPresence: one joined per visit, left on end, active unless done", () => {
    for (
      const [id, start, reports, pills, end] of [
        ["paused card picked up", "paused", ["working", "working"], ["joined"], "active"],
        ["visit ends", "paused", ["working", "ended"], ["joined", "left"], "active"],
        ["a done card stays done", "done", ["working"], ["joined"], "done"],
      ] as const
    ) {
      test(id, async () => {
        const cid = await card(id.replaceAll(" ", "-"), start);
        for (const r of reports) {
          const p = touchAgentPresence(cid, { state: r === "ended" ? "idle" : r, harness: "claude-code", name: "w-1" });
          await journalPresence(APP_CTX, cid, p, r === "ended");
        }
        expect([await journal(cid), await status(cid)]).toStrictEqual([[...pills], end]);
      });
    }

  });
}
