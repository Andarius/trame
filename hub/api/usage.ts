// Daily agent usage per device (prompts and tokens read from each install's own transcripts),
// so Insights sums every machine. Hub-only: never rides the sync protocol, like api_tokens.
import { z } from "zod";
import type { DB, Q } from "./db.ts";

export async function ensureUsageSchema(db: Q): Promise<void> {
  await db.query(`
    create table if not exists usage_days (
      node_id text not null,
      user_id uuid not null,
      d date not null,
      k text not null,
      p text,
      r text,
      a text not null,
      m text,
      prompts bigint not null default 0,
      tokens bigint not null default 0,
      primary key (node_id, d, k)
    )`);
  await db.query(
    `comment on table usage_days is
     'Hub-only: per-device daily prompts/tokens by project (p), repo (r), agent (a), model (m); k joins them.'`,
  );
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const row = z.object({
  d: day,
  p: z.string().max(64).nullable(),
  r: z.string().max(200).nullable(),
  a: z.string().min(1).max(32),
  m: z.string().max(120).nullable(),
  prompts: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export const usagePutSchema = z.object({ from: day, rows: z.array(row).max(100_000) });
export type UsagePut = z.infer<typeof usagePutSchema>;

// replaces the device's days from `from` on: a re-scan that dropped a row drops it here too
export async function putUsage(db: DB, nodeId: string, userId: string, body: UsagePut): Promise<number> {
  return await db.transaction(async (tx) => {
    await tx.query(`delete from usage_days where node_id=$1 and d >= $2::date`, [nodeId, body.from]);
    const out = await tx.query(
      `insert into usage_days (node_id, user_id, d, k, p, r, a, m, prompts, tokens)
       select $1, $2::uuid, x.d, concat_ws('|', coalesce(x.p, ''), coalesce(x.r, ''), x.a, coalesce(x.m, '')),
              x.p, x.r, x.a, x.m, sum(x.prompts), sum(x.tokens)
         from jsonb_to_recordset($3::text::jsonb)
           as x(d date, p text, r text, a text, m text, prompts bigint, tokens bigint)
        where x.d >= $4::date
        group by x.d, x.p, x.r, x.a, x.m
       returning 1`,
      [nodeId, userId, JSON.stringify(body.rows), body.from],
    );
    return out.length;
  });
}

// the same user's other devices; the caller's own counts are fresher on its side
export async function getUsage(db: Q, nodeId: string, userId: string, since: string) {
  return await db.query(
    `select node_id, to_char(d, 'YYYY-MM-DD') as d, p, r, a, m, prompts::float8 as prompts, tokens::float8 as tokens
       from usage_days where user_id=$1::uuid and node_id <> $2 and d >= $3::date
      order by d, node_id`,
    [userId, nodeId, since],
  );
}
