// Minimal DB adapter so the sync core runs on postgres.js in production and on
// PGlite in tests — one query shape, one transaction shape, nothing else.
import type postgres from "postgres";

export type Q = {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
};
export type DB = Q & {
  transaction<T>(fn: (tx: Q) => Promise<T>): Promise<T>;
};

export function pgAdapter(sql: postgres.Sql): DB {
  const q = (s: Pick<postgres.Sql, "unsafe">): Q => ({
    query: async (text, params) =>
      await s.unsafe(text, params as never[]) as unknown as Record<
        string,
        unknown
      >[],
  });
  return {
    ...q(sql),
    transaction: (fn) => sql.begin((tx) => fn(q(tx))) as Promise<never>,
  };
}
