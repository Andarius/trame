const tmp = await Deno.makeTempDir({ prefix: "trame-session-read-test-" });
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
    addSessionLink,
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
