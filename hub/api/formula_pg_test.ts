// The formula sandbox against a real Postgres (PGlite has no roles):
// TRAME_TEST_PG=postgres://owner:pw@host:port/db deno test -A formula_pg_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { pgAdapter } from "./db.ts";
import { ensureAuthSchema } from "./auth.ts";
import { ensureFormulaRole, FORMULA_ROLE, formulaQuery } from "./formula.ts";

const PG = Deno.env.get("TRAME_TEST_PG");
const ignore = !PG;
const PASSWORD = "formula-test-pw";

async function setup() {
  const owner = postgres(PG!, { max: 1, onnotice: () => {} });
  const db = pgAdapter(owner);
  await owner.unsafe(
    await Deno.readTextFile(new URL("../../db/schema.sql", import.meta.url)),
  );
  await ensureAuthSchema(db);
  await ensureFormulaRole(db, PASSWORD);
  const url = new URL(PG!);
  url.username = FORMULA_ROLE;
  url.password = PASSWORD;
  const sandbox = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return { owner, sandbox, formula: formulaQuery(sandbox) };
}

for (
  const [id, sql, rejects] of [
    ["reads udb_rows", "select count(*) as n from udb_rows", null],
    [
      "other tables denied",
      "select token_hash from api_tokens",
      /permission denied/,
    ],
    [
      "writes rejected",
      "insert into udb_rows (db_id, sort_key) values (gen_random_uuid(), 'a')",
      /read-only|permission denied/,
    ],
    [
      "nested query denied",
      "select query_to_xml('select token_hash from api_tokens', false, false, '')",
      /permission denied/,
    ],
    ["large objects rejected", "select lo_create(0)", /read-only/],
    [
      "WAL message rejected",
      "select pg_logical_emit_message(false, 'x', 'payload', true)",
      /permission denied/,
    ],
    [
      "session lock rejected",
      "select pg_advisory_lock(123)",
      /permission denied/,
    ],
    ["runaway query times out", "select pg_sleep(5)", /statement timeout/],
  ] as const
) {
  Deno.test({
    name: `formula sandbox: ${id}`,
    ignore,
    async fn() {
      const { owner, sandbox, formula } = await setup();
      try {
        if (!rejects) return void await formula.query(sql);
        const e = await assertRejects(() => formula.query(sql)) as Error;
        assertEquals(rejects.test(e.message), true, e.message);
      } finally {
        await sandbox.end();
        await owner.end();
      }
    },
  });
}

// set_config(role) to the owner is the SET ROLE escape a same-connection sandbox has
Deno.test({
  name: "formula sandbox: cannot become the owner role",
  ignore,
  async fn() {
    const { owner, sandbox, formula } = await setup();
    try {
      const ownerName = new URL(PG!).username;
      const e = await assertRejects(() =>
        formula.query(`select set_config('role', '${ownerName}', false)`)
      );
      assertEquals(/permission denied/.test((e as Error).message), true);
    } finally {
      await sandbox.end();
      await owner.end();
    }
  },
});

// a session-level change made by one formula must not leak into the next
Deno.test({
  name: "formula sandbox: settings never outlive the query",
  ignore,
  async fn() {
    const { owner, sandbox, formula } = await setup();
    try {
      await formula.query(`select set_config('statement_timeout', '0', false)`);
      const { rows } = await formula.query<{ statement_timeout: string }>(
        `show statement_timeout`,
      );
      assertEquals(rows[0].statement_timeout, "2s");
    } finally {
      await sandbox.end();
      await owner.end();
    }
  },
});
