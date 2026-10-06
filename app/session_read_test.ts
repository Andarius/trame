import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-session-read-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "session-read-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assert, assertEquals } from "@std/assert";

// The whole point of getSession: an agent handed one id sees the card the drawer shows —
// project and story by name, plus the links and worklog /api/board omits.
Deno.test("getSession resolves the card the drawer shows", async () => {
  const { db } = await import("./db.ts");
const { addEvent, addSessionLink, addTrackEvent, deleteSession, ensureSpecsPage, getSession, resolveClient, upsertSession } = await import("../core/sessions.ts");
  const { createPage, updatePage } = await import("../core/pages.ts");
  const { markdownToPageBlocks } = await import("../core/page-markdown.ts");

  const clientId = await resolveClient(APP_CTX, "Acme");
  const storyId = await createPage(APP_CTX, { title: "Ship the thing", kind: "story", parent_id: clientId });
  const id = await upsertSession(APP_CTX, {
    title: "acme api — auth",
    status: "active",
    client_id: clientId,
    page_id: storyId,
    repo_path: "/repos/acme-api",
    branch: "feat/auth",
    next_step: "wire the callback",
  });
  const specsPageId = await ensureSpecsPage(APP_CTX, id);
  await updatePage(APP_CTX, specsPageId, {
    content: markdownToPageBlocks("## Goal {{fold}}\nToken exchange"),
  });
  await addSessionLink(APP_CTX, id, storyId, null, "Ship the thing");
  for (const s of ["first", "second", "third"]) {
    await addEvent(APP_CTX, id, s, "track", "claude");
  }

  // Equal timestamps still preserve the time-ordered event IDs.
  await (await db()).query(`update session_events set at='2026-01-01T00:00:00Z' where session_id=$1`, [id]);

  const card = await getSession(APP_CTX, id);
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

  // the harness's own session id reads the same card (the Claude Code status band does this)
  const harnessId = crypto.randomUUID();
  await (await db()).query(`update sessions set claude_id=$2 where id=$1`, [id, harnessId]);
  const viaHarness = await getSession(APP_CTX, harnessId);
  assertEquals([viaHarness?.id, viaHarness?.activity_total], [id, 3]);

  // a truncated feed still reports the real count, so the agent knows it is truncated
  const capped = await getSession(APP_CTX, id, 2);
  assertEquals((capped!.activity as { summary: string }[]).map((e) => e.summary), ["third", "second"]);
  assertEquals(capped!.activity_total, 3);

  // re-tracking resends the same summary: only a changed one is a new worklog entry
  await addTrackEvent(APP_CTX, id, "third", "claude");
  assertEquals((await getSession(APP_CTX, id))!.activity_total, 3);
  await addTrackEvent(APP_CTX, id, "fourth", "claude");
  assertEquals((await getSession(APP_CTX, id))!.activity_total, 4);
  // a human typing the same line in the drawer means it, and is never swallowed
  await addEvent(APP_CTX, id, "fourth", "log");
  await addEvent(APP_CTX, id, "fourth", "log");
  assertEquals((await getSession(APP_CTX, id))!.activity_total, 6);
  // …and a manual log does not hide a track that repeats it
  await addEvent(APP_CTX, id, "fifth", "log");
  await addTrackEvent(APP_CTX, id, "fifth", "claude");
  assertEquals((await getSession(APP_CTX, id))!.activity_total, 8);
  // …nor does the same text from another agent: the worklog must show the handoff
  await addTrackEvent(APP_CTX, id, "fifth", "codex");
  assertEquals((await getSession(APP_CTX, id))!.activity_total, 9);

  // an unfiled card resolves to nulls rather than blowing up
  const bare = await upsertSession(APP_CTX, { title: "loose", status: "active", repo_path: "/repos/loose" });
  const bareCard = await getSession(APP_CTX, bare);
  assertEquals(bareCard!.project, null);
  assertEquals(bareCard!.story, null);
  assertEquals(bareCard!.activity, []);

  assertEquals(await getSession(APP_CTX, crypto.randomUUID()), null);
  await deleteSession(APP_CTX, id);
  assertEquals(await getSession(APP_CTX, id), null);
});

// The page-level feed: every linked session's worklog on one timeline. A session
// linked to several lines must still contribute each entry once.
Deno.test("listPageEvents merges the page's sessions, once per entry", async () => {
  const { addEvent, addSessionLink, listPageEvents, resolveClient, upsertSession } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");

  const clientId = await resolveClient(APP_CTX, "Feed Co");
  const pageId = await createPage(APP_CTX, { title: "Feed page", kind: "page", parent_id: clientId });
  const otherId = await createPage(APP_CTX, { title: "Other page", kind: "page", parent_id: clientId });

  const a = await upsertSession(APP_CTX, { title: "a — one", status: "active", repo_path: "/repos/a" });
  const b = await upsertSession(APP_CTX, { title: "b — two", status: "done", repo_path: "/repos/b" });
  const off = await upsertSession(APP_CTX, { title: "off — elsewhere", status: "active", repo_path: "/repos/off" });

  // `a` works on two lines of the same page — two links, one worklog
  await addSessionLink(APP_CTX, a, pageId, null, "first task");
  await addSessionLink(APP_CTX, a, pageId, null, "second task");
  await addSessionLink(APP_CTX, b, pageId, null, "third task");
  await addSessionLink(APP_CTX, off, otherId, null, "not here");

  await addEvent(APP_CTX, a, "a1", "track", "claude");
  await addEvent(APP_CTX, b, "b1", "track", "codex");
  await addEvent(APP_CTX, a, "a2", "track", "claude");
  await addEvent(APP_CTX, off, "off1", "track", null);

  const feed = await listPageEvents(APP_CTX, pageId) as {
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
