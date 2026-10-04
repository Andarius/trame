// User-written udb formula SQL runs here, never on the owner connection: its own
// login role (no SET ROLE back to the owner), SELECT on udb_rows only, and every
// query rolled back so even a session-level set_config cannot outlive it.
import type postgres from "postgres";
import type { Q as CoreQ } from "../../core/ctx.ts";
import type { Q } from "./db.ts";

export const FORMULA_ROLE = "trame_formula";

// Idempotent; run as the owner role on every start.
export async function ensureFormulaRole(
  db: Q,
  password: string,
): Promise<void> {
  await db.query(`do $$ begin
      if not exists (select from pg_roles where rolname = '${FORMULA_ROLE}') then
        create role ${FORMULA_ROLE} login;
      end if;
    end $$`);
  await db.query(
    `alter role ${FORMULA_ROLE} login connection limit 4 password '${
      password.replaceAll("'", "''")
    }'`,
  );
  await db.query(`alter role ${FORMULA_ROLE} set statement_timeout = '2s'`);
  await db.query(
    `alter role ${FORMULA_ROLE} set default_transaction_read_only = on`,
  );
  await db.query(`grant usage on schema public to ${FORMULA_ROLE}`);
  await db.query(`grant select on udb_rows to ${FORMULA_ROLE}`);
  // PUBLIC-executable functions whose effects survive the rollback (WAL, session locks)
  await db.query(`do $$ declare f regprocedure; begin
      for f in select oid::regprocedure from pg_proc where proname = any(array[
        'pg_logical_emit_message', 'pg_advisory_lock', 'pg_advisory_lock_shared',
        'pg_try_advisory_lock', 'pg_try_advisory_lock_shared'
      ]) loop
        execute format('revoke execute on function %s from public', f);
      end loop;
    end $$`);
}

class RolledBack extends Error {
  constructor(readonly rows: Record<string, unknown>[]) {
    super("rolled back");
  }
}

export function formulaQuery(sql: postgres.Sql): CoreQ {
  return {
    async query<T>(text: string, params?: unknown[]) {
      try {
        await sql.begin("read only", async (tx) => {
          throw new RolledBack(await tx.unsafe(text, params as never[]));
        });
      } catch (e) {
        if (e instanceof RolledBack) return { rows: e.rows as T[] };
        throw e;
      }
      throw new Error("formula transaction committed");
    },
  };
}

// The default: a hub without TRACKER_FORMULA_PASSWORD never evaluates formulas.
export const formulasDisabled: CoreQ = {
  query: () =>
    Promise.reject(new Error("formulas are not evaluated on this hub")),
};
