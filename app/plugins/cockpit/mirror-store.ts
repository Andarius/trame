// The database side of mirroring. Kept apart from `mirror.ts` so the planner
// stays pure and testable without a PGlite instance.
import { db } from "../../db.ts";
import { createPage, deletePage, updatePage } from "../../pages.ts";
import { type MirrorPage, type MirrorPlan, refOfContent } from "./mirror.ts";

export type MirrorResult = {
  created: number;
  updated: number;
  removed: number;
};

/**
 * The mirrored pages living under a mapping's project.
 *
 * Only pages carrying a reference mark count: a note the user wrote by hand in
 * the same project is not ours, and must never be picked up by the reconcile
 * and retired.
 */
export async function loadMirrorPages(parentId: string): Promise<MirrorPage[]> {
  const pg = await db();
  const rows = (await pg.query(
    `select id, title, content, tags from pages
      where parent_id = $1 and kind = 'story' and not deleted`,
    [parentId],
  )).rows as {
    id: string;
    title: string;
    content: unknown;
    tags: unknown;
  }[];

  const out: MirrorPage[] = [];
  for (const r of rows) {
    const content = Array.isArray(r.content) ? r.content : [];
    const ref = refOfContent(content);
    if (ref) {
      out.push({
        id: r.id,
        ref,
        title: r.title,
        content,
        tags: Array.isArray(r.tags) ? r.tags as string[] : [],
      });
    }
  }
  return out;
}

/** Apply a plan. Creates and updates first, so a failure leaves nothing retired. */
export async function applyMirror(
  parentId: string,
  plan: MirrorPlan,
): Promise<MirrorResult> {
  for (const c of plan.create) {
    await createPage({
      title: c.title,
      parent_id: parentId,
      kind: "story",
      content: c.blocks,
      tags: c.tags,
    });
  }
  for (const u of plan.update) {
    await updatePage(u.id, { title: u.title, content: u.blocks, tags: u.tags });
  }
  for (const r of plan.remove) {
    await deletePage(r.id);
  }
  return {
    created: plan.create.length,
    updated: plan.update.length,
    removed: plan.remove.length,
  };
}
