import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-session-read-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "session-read-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

// The whole point of getSession: an agent handed one id sees the card the drawer shows —
// project and story by name, plus the links and worklog /api/board omits.
Deno.test("getSession resolves the card the drawer shows", async () => {
  const {
    addEvent,
    db,
    addSessionLink,
    addTrackEvent,
    deleteSession,
    ensureSpecsPage,
    getSession,
    resolveClient,
    upsertSession,
  } = await import("./db.ts");
  const { createPage, updatePage } = await import("./pages.ts");
  const { markdownToPageBlocks } = await import("./page-markdown.ts");

  const clientId = await resolveClient("Acme");
  const storyId = await createPage({ title: "Ship the thing", kind: "story", parent_id: clientId });
  const id = await upsertSession({
    title: "acme api — auth",
    status: "active",
    client_id: clientId,
    page_id: storyId,
    repo_path: "/repos/acme-api",
    branch: "feat/auth",
    next_step: "wire the callback",
  });
  const specsPageId = await ensureSpecsPage(id);
  await updatePage(specsPageId, {
    content: markdownToPageBlocks("## Goal {{fold}}\nToken exchange"),
  });
  await addSessionLink(id, storyId, null, "Ship the thing");
  for (const s of ["first", "second", "third"]) {
    await addEvent(id, s, "track", "claude");
  }

  // Equal timestamps still preserve the time-ordered event IDs.
  await (await db()).query(`update session_events set at='2026-01-01T00:00:00Z' where session_id=$1`, [id]);

  const card = await getSession(id);
  assert(card);
  assertEquals(card.project, { id: clientId, name: "Acme" });
  assertEquals((card.story as { title: string }).title, "Ship the thing");
  assertEquals(card.branch, "feat/auth");
  assertEquals(card.next_step, "wire the callback");
  assertEquals(card.specs_page_id, specsPageId);
  assert(String(card.specs).includes("Token exchange"));
  assertEquals((card.links as { anchor: string }[]).map((l) => l.anchor), [
    "Ship the thing",
  ]);
  assertEquals((card.activity as { summary: string }[]).map((e) => e.summary), [
    "third",
    "second",
    "first",
  ]);
  assertEquals(card.activity_total, 3);

  // a truncated feed still reports the real count, so the agent knows it is truncated
  const capped = await getSession(id, 2);
  assertEquals((capped!.activity as { summary: string }[]).map((e) => e.summary), ["third", "second"]);
  assertEquals(capped!.activity_total, 3);

  // re-tracking resends the same summary: only a changed one is a new worklog entry
  await addTrackEvent(id, "third", "claude");
  assertEquals((await getSession(id))!.activity_total, 3);
  await addTrackEvent(id, "fourth", "claude");
  assertEquals((await getSession(id))!.activity_total, 4);
  // a human typing the same line in the drawer means it, and is never swallowed
  await addEvent(id, "fourth", "log");
  await addEvent(id, "fourth", "log");
  assertEquals((await getSession(id))!.activity_total, 6);
  // …and a manual log does not hide a track that repeats it
  await addEvent(id, "fifth", "log");
  await addTrackEvent(id, "fifth", "claude");
  assertEquals((await getSession(id))!.activity_total, 8);
  // …nor does the same text from another agent: the worklog must show the handoff
  await addTrackEvent(id, "fifth", "codex");
  assertEquals((await getSession(id))!.activity_total, 9);

  // an unfiled card resolves to nulls rather than blowing up
  const bare = await upsertSession({ title: "loose", status: "active", repo_path: "/repos/loose" });
  const bareCard = await getSession(bare);
  assertEquals(bareCard!.project, null);
  assertEquals(bareCard!.story, null);
  assertEquals(bareCard!.activity, []);

  assertEquals(await getSession(crypto.randomUUID()), null);
  await deleteSession(id);
  assertEquals(await getSession(id), null);
});

// The page-level feed: every linked session's worklog on one timeline. A session
// linked to several lines must still contribute each entry once.
Deno.test("listPageEvents merges the page's sessions, once per entry", async () => {
  const { addEvent, addSessionLink, listPageEvents, resolveClient, upsertSession } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");

  const clientId = await resolveClient("Feed Co");
  const pageId = await createPage({ title: "Feed page", kind: "page", parent_id: clientId });
  const otherId = await createPage({ title: "Other page", kind: "page", parent_id: clientId });

  const a = await upsertSession({ title: "a — one", status: "active", repo_path: "/repos/a" });
  const b = await upsertSession({ title: "b — two", status: "done", repo_path: "/repos/b" });
  const off = await upsertSession({ title: "off — elsewhere", status: "active", repo_path: "/repos/off" });

  // `a` works on two lines of the same page — two links, one worklog
  await addSessionLink(a, pageId, null, "first task");
  await addSessionLink(a, pageId, null, "second task");
  await addSessionLink(b, pageId, null, "third task");
  await addSessionLink(off, otherId, null, "not here");

  await addEvent(a, "a1", "track", "claude");
  await addEvent(b, "b1", "track", "codex");
  await addEvent(a, "a2", "track", "claude");
  await addEvent(off, "off1", "track", null);

  const feed = await listPageEvents(pageId) as {
    id: string;
    summary: string;
    session_id: string;
    session_title: string;
    session_status: string;
  }[];

  assertEquals(feed.map((e) => e.summary), ["a2", "b1", "a1"]); // newest first
  assertEquals(new Set(feed.map((e) => e.id)).size, 3); // two links ≠ two copies
  assertEquals(feed.find((e) => e.summary === "b1")!.session_title, "b — two");
  assertEquals(feed.find((e) => e.summary === "b1")!.session_status, "done");
  assert(!feed.some((e) => e.session_id === off)); // another page's session stays out
});
