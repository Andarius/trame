import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-hierarchy-marks-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "hierarchy-marks-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assertEquals } from "@std/assert";
import { isUserStory, storyAbove } from "../core/hierarchy.ts";
import { createPage } from "../core/pages.ts";
import { addMarkRoles } from "../core/mark-roles.ts";

// Pins what mark roles mean to the hierarchy; a plugin declares the real rules (mark-roles.json).
addMarkRoles([
  { mark: "tracker_us", value: /^US-\d+$/, role: "linked-story" },
  { mark: "tracker_ref", value: /^GEN-\d+$/, role: "ticket" },
]);
const line = (text: string) => [{ id: crypto.randomUUID(), type: "text", text }];
const US = (n: number) => line(`{{trame:tracker_us=US-${n}}}`);
const GEN = (n: number) => line(`{{trame:tracker_ref=GEN-${n}}}`);

Deno.test("isUserStory: a US mark makes any page one; a GEN mark unmakes a story", async (t) => {
  const cases: [string, { kind?: string; content?: unknown[] }, boolean][] = [
    ["plain story", { kind: "story" }, true],
    ["story mirroring a ticket", { kind: "story", content: GEN(5) }, false],
    ["story with a non-GEN ref", { kind: "story", content: line("{{trame:tracker_ref=OPS-5}}") }, true],
    ["page filed as a US", { kind: "page", content: US(3) }, true],
    ["page with a malformed US", { kind: "page", content: line("{{trame:tracker_us=story-3}}") }, false],
    ["plain page", { kind: "page" }, false],
  ];
  for (const [name, page, expected] of cases) {
    await t.step(name, () => assertEquals(isUserStory(page), expected));
  }
});

Deno.test("storyAbove: nearest US-linked page, else outermost user story, else outermost story", async (t) => {
  const project = await createPage(APP_CTX, { title: "Hierarchy Co", kind: "project", parent_id: null });
  const under = (parent_id: string, kind: string, content: unknown[] = []) =>
    createPage(APP_CTX, { title: `${kind} ${crypto.randomUUID()}`, kind, parent_id, content });
  // legacy data can nest stories the writer now refuses, so build those links directly
  const nest = async (id: string, parent: string) => {
    const { db } = await import("./db.ts");
    await (await db()).query(`update pages set parent_id=$2 where id=$1`, [id, parent]);
  };

  await t.step("a ticket story under a US page anchors on the US", async () => {
    const us = await under(project, "story", US(7));
    const ticket = await under(us, "story", GEN(50));
    const doc = await under(ticket, "page");
    assertEquals(await storyAbove(APP_CTX, doc), us);
  });

  await t.step("a US-marked plain page wins over a plain story above it", async () => {
    const story = await under(project, "story");
    const linked = await under(project, "page", US(9));
    await nest(linked, story);
    const doc = await under(linked, "page");
    assertEquals(await storyAbove(APP_CTX, doc), linked);
  });

  await t.step("nested plain stories anchor on the outermost", async () => {
    const outer = await under(project, "story");
    const inner = await under(project, "story");
    await nest(inner, outer);
    const doc = await under(inner, "page");
    assertEquals(await storyAbove(APP_CTX, doc), outer);
  });

  await t.step("a lone ticket story is still the story of last resort", async () => {
    const ticket = await under(project, "story", GEN(51));
    const doc = await under(ticket, "page");
    assertEquals(await storyAbove(APP_CTX, doc), ticket);
  });

  await t.step("the search stops at the project", async () => {
    const story = await under(project, "story");
    const inner = await under(story, "project");
    const doc = await under(inner, "page");
    assertEquals(await storyAbove(APP_CTX, doc), null);
  });
});
