// Device→user identity (hub-API migration, phase 1). A device (NODE_ID) maps to a
// users row through the synced devices table; writes stamp the resolved user id.
import { v5 } from "@std/uuid";
import type { PGlite } from "@electric-sql/pglite";
import { db } from "./db.ts";
import { NODE_ID, SETTINGS_FILE } from "./config.ts";
import { getHubApi } from "./files.ts";

// Deterministic device ids: two racing claims of the same NODE_ID converge on one
// row instead of forking (same reason statusId derives from the status key).
const DEVICE_NS = "9c2f6a71-4b8e-4d05-a3c9-2e61d7f0b842";
export const deviceId = (nodeId: string) =>
  v5.generate(DEVICE_NS, new TextEncoder().encode(nodeId));

// Claim this NODE_ID for the sole user. With several users we can't guess — the
// device stays unclaimed until the hub API's claim flow (phase 3). Runs inside db()
// init (handle passed in), so PGlite stays lazy — nothing forces it open at startup.
// When API sync is configured the claim is SKIPPED entirely: the hub binds devices
// at mint/invite time and the row syncs down — a fresh replica claiming locally
// would bind to the seeded user before the first pull brings the real user set.
export async function claimDevice(handle?: PGlite): Promise<void> {
  if (await getHubApi().catch(() => null)) return;
  const pg = handle ?? await db();
  const claimed = (await pg.query(
    `select 1 from devices where node_id=$1 and not deleted limit 1`,
    [NODE_ID],
  )).rows.length > 0;
  if (claimed) return;
  const users = (await pg.query(`select id from users where not deleted`))
    .rows as { id: string }[];
  if (users.length !== 1) return;
  await pg.query(
    `insert into devices (id, node_id, user_id, origin) values ($1,$2,$3,$4)
     on conflict (id) do nothing`,
    [await deviceId(NODE_ID), NODE_ID, users[0].id, NODE_ID],
  );
}

export type Identity = { userId: string | null; name: string; avatar: string };

async function localAuthorSettings(): Promise<
  { name: string; avatar: string }
> {
  try {
    const s = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
    return {
      name: typeof s.authorName === "string" ? s.authorName.trim() : "",
      avatar: typeof s.authorAvatar === "string" ? s.authorAvatar.trim() : "",
    };
  } catch {
    return { name: "", avatar: "" };
  }
}

// Who this device writes as: NODE_ID → devices → users. Display fields prefer the
// device-local settings override, then the synced profile, then the node id.
export async function getIdentity(): Promise<Identity> {
  const pg = await db();
  const u = (await pg.query(
    `select u.id, u.name, u.avatar from devices d
      join users u on u.id = d.user_id and not u.deleted
      where d.node_id=$1 and not d.deleted limit 1`,
    [NODE_ID],
  )).rows[0] as { id: string; name: string; avatar: string } | undefined;
  const local = await localAuthorSettings();
  return {
    userId: u?.id ?? null,
    name: local.name || u?.name.trim() || NODE_ID,
    avatar: local.avatar || u?.avatar.trim() || "",
  };
}

// Update the synced profile of this device's user. No-op while the device is unclaimed.
export async function updateUserProfile(
  patch: { name?: string; avatar?: string },
): Promise<void> {
  if (patch.name === undefined && patch.avatar === undefined) return;
  const pg = await db();
  const d = (await pg.query(
    `select user_id from devices where node_id=$1 and not deleted limit 1`,
    [NODE_ID],
  )).rows[0] as { user_id: string } | undefined;
  if (!d) return;
  await pg.query(
    `update users set name = coalesce($2, name), avatar = coalesce($3, avatar),
       origin = $4, updated_at = now()
     where id = $1`,
    [
      d.user_id,
      patch.name?.trim() ?? null,
      patch.avatar?.trim() ?? null,
      NODE_ID,
    ],
  );
}
