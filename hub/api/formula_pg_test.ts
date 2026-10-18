// The formula sandbox against a real Postgres (PGlite has no roles):
// TRAME_TEST_PG=postgres://owner:pw@host:port/db bun test formula_pg_test.ts
import { expect, test } from "bun:test";
import postgres from "postgres";
import { pgAdapter } from "./db.ts";
import { ensureAuthSchema } from "./auth.ts";
import { ensureFormulaRole, FORMULA_ROLE, formulaQuery } from "./formula.ts";

const PG = process.env.TRAME_TEST_PG;
const ignore = !PG;
const PASSWORD = "formula-test-pw";

async function setup() {
  const owner = postgres(PG!, { max: 1, onnotice: () => {} });
  const db = pgAdapter(owner);
  await owner.unsafe(
    await Bun.file(new URL("../../db/schema.sql", import.meta.url)).text(),
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
  test.skipIf(ignore)(`formula sandbox: ${id}`, async () => {
    const { owner, sandbox, formula } = await setup();
    try {
      if (!rejects) return void await formula.query(sql);
      await expect(formula.query(sql)).rejects.toThrow(rejects);
    } finally {
      await sandbox.end();
      await owner.end();
    }
  });
}

// set_config(role) to the owner is the SET ROLE escape a same-connection sandbox has
test.skipIf(ignore)("formula sandbox: cannot become the owner role", async () => {
  const { owner, sandbox, formula } = await setup();
  try {
    const ownerName = new URL(PG!).username;
    await expect(formula.query(`select set_config('role', '${ownerName}', false)`)).rejects.toThrow(
      /permission denied/,
    );
  } finally {
    await sandbox.end();
    await owner.end();
  }
});

// a session-level change made by one formula must not leak into the next
test.skipIf(ignore)("formula sandbox: settings never outlive the query", async () => {
  const { owner, sandbox, formula } = await setup();
  try {
    await formula.query(`select set_config('statement_timeout', '0', false)`);
    const { rows } = await formula.query<{ statement_timeout: string }>(`show statement_timeout`);
    expect(rows[0].statement_timeout).toStrictEqual("2s");
  } finally {
    await sandbox.end();
    await owner.end();
  }
});
