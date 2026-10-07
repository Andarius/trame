import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-due-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "due-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assertEquals } from "@std/assert";

Deno.test("listDue returns open todos with a due mark, a spec page's pointing at its card", async () => {
  const { createPage, updatePage } = await import("../core/pages.ts");
  const { ensureSpecsPage, upsertSession } = await import("../core/sessions.ts");
  const { listDue } = await import("../core/due.ts");
  const { markdownToPageBlocks } = await import("../core/page-markdown.ts");

  const plain = await createPage(APP_CTX, { title: "Rollout" });
  await updatePage(APP_CTX, plain, {
    content: markdownToPageBlocks(
      [
        "- [ ] track-backend: bump when stubs ship {{trame:due=2026-10-13}} {{trame:created_at=2026-10-09}}",
        "- [x] already done {{trame:due=2026-10-01}}",
        "- [ ] no date",
        "- [ ] malformed date {{trame:due=soon}}",
      ].join("\n"),
    ),
  });
  const card = await upsertSession(APP_CTX, { title: "asyncpg rollout", status: "active" });
  const spec = await ensureSpecsPage(APP_CTX, card);
  await updatePage(APP_CTX, spec, {
    content: markdownToPageBlocks("- [ ] polarsen: bump asyncpg {{trame:due=2026-10-11}}"),
  });

  const due = await listDue(APP_CTX);
  assertEquals(
    due.map((d) => [d.text, d.due, d.page_id, d.card_id]),
    [
      ["polarsen: bump asyncpg", "2026-10-11", spec, card],
      ["track-backend: bump when stubs ship", "2026-10-13", plain, null],
    ],
  );
});

Deno.test("daysUntil and the shown window", async (t) => {
  const { daysUntil, isShownDue } = await import("../core/due.ts");
  for (
    const [id, due, days, shown] of [
      ["late", "2026-10-06", -3, true],
      ["today", "2026-10-09", 0, true],
      ["last day of the window", "2026-10-16", 7, true],
      ["beyond the window", "2026-10-17", 8, false],
    ] as const
  ) {
    await t.step(id, () => {
      assertEquals([daysUntil(due, "2026-10-09"), isShownDue(due, "2026-10-09")], [days, shown]);
    });
  }
});

Deno.test("digest counts late and soon, shows nothing when nothing is due", async (t) => {
  const { digest } = await import("./due_notify.ts");
  const todo = (text: string, due: string) => ({ page_id: "p", page_title: "P", block_id: null, card_id: null, text, due });
  for (
    const [id, due, expected] of [
      ["nothing due", [todo("far away", "2026-11-30")], null],
      ["late and soon", [todo("rotate secret", "2026-10-06"), todo("bump polarsen", "2026-10-11")], {
        title: "Trame · 1 late, 1 due this week",
        body: "⚑ rotate secret (3d late)\n⚑ bump polarsen (2026-10-11)",
      }],
      ["only soon", [todo("bump", "2026-10-10")], { title: "Trame · 1 due this week", body: "⚑ bump (tomorrow)" }],
    ] as const
  ) {
    await t.step(id, () => assertEquals(digest([...due], "2026-10-09"), expected));
  }
});
