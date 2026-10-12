import postgres from "postgres";
import type { Q } from "../core/ctx.ts";

export type Database = Q & {
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function socketPg(socket: string): Database {
  const jsonText = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  const sql = postgres({
    path: `${socket}/.s.PGSQL.55439`,
    port: 55439,
    username: "trame",
    database: "postgres",
    max: 1,
    onnotice: () => {},
    types: {
      jsonb: { to: 3802, from: [3802], serialize: jsonText, parse: JSON.parse },
      json: { to: 114, from: [114], serialize: jsonText, parse: JSON.parse },
      // Match PGlite's int8 decoding for count() and sync cursors.
      int8: { to: 20, from: [20], serialize: String, parse: Number },
    },
  });
  const q = (handle: Pick<typeof sql, "unsafe">): Q => ({
    query: async <T>(text: string, params?: unknown[]) => ({
      rows: await handle.unsafe(text, params as never[]) as unknown as T[],
    }),
  });
  return {
    ...q(sql),
    exec: async (text) => await sql.unsafe(text).simple(),
    transaction<T>(fn: (tx: Q) => Promise<T>) {
      return sql.begin((tx) => fn(q(tx))) as Promise<T>;
    },
    close: () => sql.end(),
  };
}
