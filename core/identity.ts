import type { Ctx } from "./ctx.ts";

export type Identity = { userId: string | null; name: string; avatar: string };

// The user behind ctx.origin's device; a local author override wins over the synced profile.
export async function identityOf(ctx: Ctx): Promise<Identity> {
  const u = (await ctx.q.query<{ id: string; name: string; avatar: string }>(
    `select u.id, u.name, u.avatar from devices d
      join users u on u.id = d.user_id and not u.deleted
      where d.node_id=$1 and not d.deleted limit 1`,
    [ctx.origin],
  )).rows[0];
  const local = await ctx.localAuthor?.() ?? { name: "", avatar: "" };
  return {
    userId: u?.id ?? null,
    name: local.name || u?.name.trim() || ctx.origin,
    avatar: local.avatar || u?.avatar.trim() || "",
  };
}
