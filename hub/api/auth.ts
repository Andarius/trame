// Per-device opaque bearer tokens, hub-only (this table never rides the laptop sync
// and is NOT in db/schema.sql). Tokens are high-entropy random values, so a plain
// sha-256 lookup hash is the right primitive — argon2id is for the password login
// that arrives with multi-user onboarding, not for random tokens.
import type { DB, Q } from "./db.ts";

export async function ensureAuthSchema(db: Q): Promise<void> {
  await db.query(`
    create table if not exists api_tokens (
      id uuid primary key default gen_random_uuid(),
      token_hash text not null unique,
      node_id text not null,
      created_at timestamptz not null default now(),
      revoked boolean not null default false
    )`);
  await db.query(
    `comment on table api_tokens is
     'Hub-only: per-device opaque API tokens (sha-256 of the token). Revoke by flipping revoked.'`,
  );
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// Mint a token for a device. Printed once by the CLI; only the hash is stored.
export async function mintToken(db: Q, nodeId: string): Promise<string> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = btoa(String.fromCharCode(...raw)).replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  await db.query(
    `insert into api_tokens (token_hash, node_id) values ($1, $2)`,
    [await sha256hex(token), nodeId],
  );
  return token;
}

export type Caller = { nodeId: string; userId: string | null };

// Bearer token → device, then devices → user (the actor stamped into change_log).
// A claimed device may still map to no user — that's fine.
export async function verifyToken(
  db: DB,
  token: string,
): Promise<Caller | null> {
  const rows = await db.query(
    `select node_id from api_tokens where token_hash=$1 and not revoked`,
    [await sha256hex(token)],
  );
  const nodeId = rows[0]?.node_id as string | undefined;
  if (!nodeId) return null;
  const dev = await db.query(
    `select user_id from devices where node_id=$1 and not deleted limit 1`,
    [nodeId],
  );
  return { nodeId, userId: (dev[0]?.user_id as string | undefined) ?? null };
}
