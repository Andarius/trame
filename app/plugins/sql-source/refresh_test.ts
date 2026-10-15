import { testTempDir } from "../../test_tmp.ts";
// Isolated PGlite for the Trame side; set the env before any app module loads.
const tmp = testTempDir("trame-sql-source-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "sql-source-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL("../../", import.meta.url).pathname);
const { APP_CTX, inTransaction } = await import("../../ctx.ts");
const { createProperty, createUdb, getUdb, patchRow, updateProperty } = await import("../../../core/udb.ts");
const { applyRefresh, runSourceQuery, SourceError } = await import("./refresh.ts");
type Source = import("./refresh.ts").Source;
type SourceResult = import("./refresh.ts").SourceResult;

import { assert, assertEquals, assertRejects } from "@std/assert";

// Trame-side merge, against a fixed source result

const TEXT = 25, INT = 23, BOOL = 16, DATE = 1082;
const COLUMNS = [
  { name: "key", type: TEXT },
  { name: "n", type: INT },
  { name: "flag", type: BOOL },
  { name: "day", type: DATE },
];
const result = (rows: Record<string, unknown>[], columns = COLUMNS): SourceResult => ({ columns, rows });
const R1 = result([
  { key: "a", n: 1, flag: true, day: "2026-10-01" },
  { key: "b", n: 2, flag: false, day: null },
]);

async function newSource(deleteMissing = false): Promise<Source> {
  const db_id = await createUdb(APP_CTX, `t-${crypto.randomUUID()}`);
  return {
    id: "src",
    name: "test",
    dsn: "",
    query: "",
    db_id,
    key_column: "key",
    interval_min: 0,
    delete_missing: deleteMissing,
  };
}

const apply = (s: Source, r: SourceResult) => inTransaction((ctx) => applyRefresh(ctx, s, r));

async function table(s: Source) {
  const udb = (await getUdb(APP_CTX, s.db_id))!;
  const name = new Map(udb.properties.map((p) => [p.id, p.name as string]));
  return udb.rows.map((r) =>
    Object.fromEntries(Object.entries(r.vals as Record<string, unknown>).map(([k, v]) => [name.get(k), v]))
  ).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

const writes = async () =>
  ((await APP_CTX.q.query(`select count(*)::int as n from change_log`)).rows[0] as { n: number }).n;

const propBy = async (s: Source, name: string) =>
  (await getUdb(APP_CTX, s.db_id))!.properties.find((p) => p.name === name)!;

const rowBy = async (s: Source, key: string) => {
  const keyProp = await propBy(s, "key");
  return (await getUdb(APP_CTX, s.db_id))!.rows.find((r) => r.vals[keyProp.id] === key)!;
};

type MergeCase = {
  name: string;
  deleteMissing?: boolean;
  before?: (s: Source) => Promise<void>;
  run: SourceResult;
  counts: { created: number; updated: number; deleted: number };
  rows: Record<string, unknown>[];
  // change_log entries the second refresh may add
  logged?: number;
};

const mergeCases: MergeCase[] = [
  {
    name: "first fill creates owned columns and rows",
    run: R1,
    counts: { created: 2, updated: 0, deleted: 0 },
    rows: [
      { key: "a", n: 1, flag: true, day: { start: "2026-10-01" } },
      { key: "b", n: 2, flag: false },
    ],
  },
  {
    name: "unchanged re-run writes nothing",
    before: async (s) => void await apply(s, R1),
    run: R1,
    counts: { created: 0, updated: 0, deleted: 0 },
    rows: [
      { key: "a", n: 1, flag: true, day: { start: "2026-10-01" } },
      { key: "b", n: 2, flag: false },
    ],
    logged: 0,
  },
  {
    name: "a changed value patches only source keys and keeps a user edit",
    before: async (s) => {
      await apply(s, R1);
      const note = await createProperty(APP_CTX, s.db_id, { name: "note", type: "text" });
      await patchRow(APP_CTX, (await rowBy(s, "a")).id, { [note]: "mine" });
    },
    run: result([{ key: "a", n: 5, flag: true, day: "2026-10-01" }, { key: "b", n: 2, flag: false, day: null }]),
    counts: { created: 0, updated: 1, deleted: 0 },
    rows: [
      { key: "a", n: 5, flag: true, day: { start: "2026-10-01" }, note: "mine" },
      { key: "b", n: 2, flag: false },
    ],
    logged: 1,
  },
  {
    name: "a vanished key is kept without delete_missing",
    before: async (s) => void await apply(s, R1),
    run: result([{ key: "a", n: 1, flag: true, day: "2026-10-01" }]),
    counts: { created: 0, updated: 0, deleted: 0 },
    rows: [
      { key: "a", n: 1, flag: true, day: { start: "2026-10-01" } },
      { key: "b", n: 2, flag: false },
    ],
  },
  {
    name: "delete_missing soft-deletes a vanished key",
    deleteMissing: true,
    before: async (s) => void await apply(s, R1),
    run: result([{ key: "a", n: 1, flag: true, day: "2026-10-01" }]),
    counts: { created: 0, updated: 0, deleted: 1 },
    rows: [{ key: "a", n: 1, flag: true, day: { start: "2026-10-01" } }],
  },
  {
    name: "a renamed owned column keeps its cells",
    before: async (s) => {
      await apply(s, R1);
      await updateProperty(APP_CTX, (await propBy(s, "n")).id, { name: "count" });
    },
    run: R1,
    counts: { created: 0, updated: 0, deleted: 0 },
    rows: [
      { key: "a", count: 1, flag: true, day: { start: "2026-10-01" } },
      { key: "b", count: 2, flag: false },
    ],
    logged: 0,
  },
  {
    name: "a detached column is left to the user",
    before: async (s) => {
      await apply(s, R1);
      await updateProperty(APP_CTX, (await propBy(s, "n")).id, { config: { source: null } });
    },
    run: result([{ key: "a", n: 9, flag: true, day: "2026-10-01" }, { key: "b", n: 9, flag: false, day: null }]),
    counts: { created: 0, updated: 0, deleted: 0 },
    rows: [
      { key: "a", n: 1, flag: true, day: { start: "2026-10-01" } },
      { key: "b", n: 2, flag: false },
    ],
  },
];

for (const c of mergeCases) {
  Deno.test(`sql-source merge: ${c.name}`, async () => {
    const s = await newSource(c.deleteMissing);
    await c.before?.(s);
    const before = await writes();
    const counts = await apply(s, c.run);
    assertEquals(counts, { rows: c.run.rows.length, ...c.counts });
    assertEquals(await table(s), c.rows);
    if (c.logged !== undefined) assertEquals(await writes() - before, c.logged);
    const owned = (await getUdb(APP_CTX, s.db_id))!.properties.filter((p) => p.config.source === "src");
    assertEquals(owned.length, c.name.includes("detached") ? 3 : 4, "result columns are source-owned");
  });
}

const refusedCases: { name: string; run: SourceResult; error: string }[] = [
  { name: "missing key column", run: result([{ n: 1 }], [{ name: "n", type: INT }]), error: "not in the query results" },
  { name: "duplicate key", run: result([{ key: "a" }, { key: "a" }]), error: "not unique" },
  { name: "empty key", run: result([{ key: "a" }, { key: null }]), error: "empty values" },
];

for (const c of refusedCases) {
  Deno.test(`sql-source merge refuses without writing: ${c.name}`, async () => {
    const s = await newSource(true);
    const before = await writes();
    await assertRejects(() => apply(s, c.run), SourceError, c.error);
    assertEquals(await writes(), before);
    assertEquals((await getUdb(APP_CTX, s.db_id))!.properties.length, 1, "only the title column");
  });
}

// Source side, against a throwaway PostgreSQL (TRAME_PG_BIN, as `just test` sets it)

const PG_BIN = Deno.env.get("TRAME_PG_BIN");
const hasPg = !!PG_BIN && await Deno.stat(`${PG_BIN}/pg_ctl`).then(() => true, () => false);

async function run(cmd: string, args: string[]) {
  const out = await new Deno.Command(`${PG_BIN}/${cmd}`, { args, stdout: "null", stderr: "piped" }).output();
  if (!out.success) throw new Error(`${cmd}: ${new TextDecoder().decode(out.stderr)}`);
}

Deno.test({
  name: "sql-source runs the query read-only, bounded and capped",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const dir = Deno.makeTempDirSync({ prefix: "trame-sqlsrc-pg-" });
    // a socket path is capped at 107 bytes, and TMPDIR can be deep (oracle-check)
    const sock = Deno.makeTempDirSync({ dir: "/tmp", prefix: "sqlsrc-" });
    const port = 55000 + Math.floor(Math.random() * 400);
    await run("initdb", ["-D", `${dir}/data`, "--username=src", "--auth-local=trust", "--auth-host=reject", "--no-sync"]);
    await run("pg_ctl", [
      "-D",
      `${dir}/data`,
      "-w",
      "-l",
      `${dir}/log`,
      "-o",
      `-c listen_addresses= -k ${sock} -p ${port} -c dynamic_library_path=${PG_BIN}/../lib`,
      "start",
    ]);
    const dsn = `postgres://src@localhost:${port}/postgres?host=${sock}`;
    try {
      // a function that writes, so the write is reachable from a plain select
      const setup = (await import("postgres")).default({ path: `${sock}/.s.PGSQL.${port}`, username: "src", database: "postgres", onnotice: () => {} });
      await setup.unsafe(`create table t (id int);
        create function w() returns int language sql as 'insert into t values (1) returning id';`);

      const cases: { name: string; query: string; maxRows?: number; timeoutMs?: number; error?: string; rows?: number }[] = [
        { name: "a select returns typed columns", query: "select 'a' as key, 1 as n, true as flag, date '2026-10-01' as day;", rows: 1 },
        { name: "rows up to the cap", query: "select g from generate_series(1, 10) g", maxRows: 10, rows: 10 },
        { name: "past the cap is refused", query: "select g from generate_series(1, 11) g", maxRows: 10, error: "more than 10 rows" },
        { name: "a write is rejected by the read-only transaction", query: "select w()", error: "read-only transaction" },
        {
          name: "a statement smuggled past the wrapper is rejected",
          query: "select 1) x; commit; insert into t values (2); select * from (select 1",
          error: "multiple commands",
        },
        { name: "a slow query hits the timeout", query: "select pg_sleep(5)", timeoutMs: 200, error: "statement timeout" },
      ];
      for (const c of cases) {
        await t.step(c.name, async () => {
          const go = () => runSourceQuery(dsn, c.query, { maxRows: c.maxRows, timeoutMs: c.timeoutMs });
          if (c.error) {
            await assertRejects(go, SourceError, c.error);
          } else {
            const r = await go();
            assertEquals(r.rows.length, c.rows);
          }
        });
      }
      await t.step("columns keep their type oids and dates stay text", async () => {
        const r = await runSourceQuery(dsn, "select 'a' as key, 1 as n, true as flag, date '2026-10-01' as day");
        assertEquals(r.columns, COLUMNS);
        assertEquals(r.rows[0], { key: "a", n: 1, flag: true, day: "2026-10-01" });
      });
      assertEquals((await setup.unsafe(`select count(*)::int as n from t`))[0].n, 0, "nothing was written");
      await setup.end();
      await t.step("errors never carry the password", async () => {
        const err = await assertRejects(
          () => runSourceQuery(`postgres://src:s3cret@127.0.0.1:1/postgres`, "select 1"),
          SourceError,
        );
        assert(!err.message.includes("s3cret"), err.message);
      });
    } finally {
      await run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]).catch(() => {});
      Deno.removeSync(dir, { recursive: true });
      Deno.removeSync(sock, { recursive: true });
    }
  },
});

// Settings: the connection string is write-only and stays in the 0600 device-local file

Deno.test("sql-source settings never echo the connection string", async () => {
  const { handlePluginRoute } = await import("../index.ts");
  const plugin = (await import("./mod.ts")).default;
  const call = async (body?: unknown) => {
    const url = new URL("http://x/api/plugins/sql-source/settings");
    const req = new Request(url, body ? { method: "POST", body: JSON.stringify(body) } : {});
    return await (await handlePluginRoute(req, url, [plugin])).json();
  };
  const dsn = "postgres://u:s3cret@db.internal:5432/okr";
  const draft = { name: "OKR", dsn, query: "select 1", key_column: "id", interval_min: 5, extra: "dropped" };
  const created = await call({ sources: [draft] });
  const id = created.sources[0].id;
  // a resave without the dsn keeps the stored one
  const cases: [string, unknown][] = [
    ["create", created],
    ["resave", await call({ sources: [{ ...created.sources[0], dsn: "" }] })],
    ["get", await call()],
  ];
  for (const [label, view] of cases) {
    assert(!JSON.stringify(view).includes("s3cret"), label);
    assertEquals((view as { sources: Record<string, unknown>[] }).sources, [{
      id,
      name: "OKR",
      query: "select 1",
      db_id: "",
      key_column: "id",
      interval_min: 5,
      delete_missing: false,
      hasDsn: true,
    }], label);
  }
  const file = Deno.env.get("TRACKER_SETTINGS_FILE")!;
  assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
  assertEquals(JSON.parse(await Deno.readTextFile(file)).plugins["sql-source"].sources[0].dsn, dsn);
});
