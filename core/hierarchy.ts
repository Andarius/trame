import type { Ctx } from "./ctx.ts";
import { hasRole } from "./mark-roles.ts";

export function isUserStory(
  page: { kind?: string; content?: unknown[] },
): boolean {
  const content = page.content ?? [];
  return hasRole(content, "linked-story") || (page.kind === "story" && !hasRole(content, "ticket"));
}

/** Find the nearest linked US or outermost local story without crossing a project boundary. */
export async function storyAbove(ctx: Ctx, pageId: string): Promise<string | null> {
  const pg = ctx.q;
  const rows = (await pg.query(
    `with recursive up as (
       select id, parent_id, kind, content, array[id] as path from pages where id=$1 and not deleted
       union all
       select p.id, p.parent_id, p.kind, p.content, up.path || p.id
         from pages p join up on p.id=up.parent_id
        where not p.deleted and up.kind <> 'project' and not p.id=any(up.path)
     ) select id, kind, content from up order by cardinality(path)`,
    [pageId],
  )).rows as { id: string; kind: string; content: unknown[] }[];
  const linked = rows.find((p) => hasRole(p.content, "linked-story"));
  return linked?.id ?? rows.filter(isUserStory).at(-1)?.id ??
    rows.filter((p) => p.kind === "story").at(-1)?.id ?? null;
}

/** The nearest project ancestor of a page, or null. Server-side twin of the web's `projectOf`. */
export async function projectAbove(ctx: Ctx, pageId: string): Promise<string | null> {
  const pg = ctx.q;
  const row = (await pg.query(
    `with recursive up as (
       select id, parent_id, kind, 0 as d, array[id] as path
         from pages where id=$1 and not deleted
       union all
       select p.id, p.parent_id, p.kind, up.d + 1, up.path || p.id
         from pages p join up on p.id = up.parent_id
        where not p.deleted and not p.id = any(up.path)
     ) select id from up where kind='project' order by d limit 1`,
    [pageId],
  )).rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

export async function checkStoryParent(ctx: Ctx, parentId: string | null): Promise<void> {
  if (parentId && await storyAbove(ctx, parentId)) {
    throw new Error(
      "A user story cannot be nested under another user story. Create a ticket/session or a documentation page instead.",
    );
  }
}
