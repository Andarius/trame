import { describe, expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-due-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "due-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


test("listDue returns open todos with a due mark, a spec page's pointing at its card", async () => {
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
  expect(due.map((d) => [d.text, d.due, d.page_id, d.card_id])).toStrictEqual([
      ["polarsen: bump asyncpg", "2026-10-11", spec, card],
      ["track-backend: bump when stubs ship", "2026-10-13", plain, null],
    ]);
});

{
  const { daysUntil, isShownDue } = await import("../core/due.ts");
  describe("daysUntil and the shown window", () => {
    for (
      const [id, due, days, shown] of [
        ["late", "2026-10-06", -3, true],
        ["today", "2026-10-09", 0, true],
        ["last day of the window", "2026-10-16", 7, true],
        ["beyond the window", "2026-10-17", 8, false],
      ] as const
    ) {
      test(id, () => {
        expect([daysUntil(due, "2026-10-09"), isShownDue(due, "2026-10-09")]).toStrictEqual([days, shown]);
      });
    }

  });
}
