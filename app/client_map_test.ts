import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
process.env.TRACKER_CLIENTS = '{"Obitrain":"Obitrain","Work":{"project":"Soren","tags":["Infra"],"repos":["sre-config"]}}';
const tmp = testTempDir("trame-client-map-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "client-map-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


const { defaultTagsFor } = await import("./config.ts");

test("the repo whitelist gates default tags", () => {
  // the repo basename sits at the END of repo_path — must still match
  expect(defaultTagsFor("/home/me/Projects/Work/sre-config")).toStrictEqual(["Infra"]);
  expect(defaultTagsFor("/home/me/Projects/Work/sre-config/packages/sctl")).toStrictEqual(["Infra"]);
  expect(defaultTagsFor("/tmp/claude-1000/-home-me-Work-sre-config/x/wt-a")).toStrictEqual(["Infra"]);
  // a sibling repo gets no tags
  expect(defaultTagsFor("/home/me/Projects/Work/track-backend")).toStrictEqual([]);
});

const { db } = await import("./db.ts");
const { upsertSession } = await import("../core/sessions.ts");

test("a story minted for a mapped repo carries the default tags", async () => {
  const id = await upsertSession(APP_CTX, {
    title: "sre-config — probe",
    repo_path: "/home/me/Projects/Work/sre-config/packages/sctl",
    branch: "main",
    client: "Soren",
    story: "Blackbox probes",
  });
  const pg = await db();
  const { page_id } = (await pg.query(`select page_id from sessions where id=$1`, [id]))
    .rows[0] as { page_id: string };
  const page = (await pg.query(`select tags from pages where id=$1`, [page_id]))
    .rows[0] as { tags: string[] };
  expect(page.tags).toStrictEqual(["infra"]);
  // vocabulary row exists, labelled as written
  const tag = (await pg.query(`select label from tags where key='infra' and not deleted`))
    .rows[0] as { label: string };
  expect(tag.label).toStrictEqual("Infra");
  // re-attaching by the same story name must not re-stamp or duplicate
  const again = await upsertSession(APP_CTX, {
    title: "sre-config — probe 2",
    repo_path: "/home/me/Projects/Work/sre-config",
    branch: "other",
    client: "Soren",
    story: "blackbox probes",
  });
  const p2 = (await pg.query(`select page_id from sessions where id=$1`, [again]))
    .rows[0] as { page_id: string };
  expect(p2.page_id).toStrictEqual(page_id);
});
