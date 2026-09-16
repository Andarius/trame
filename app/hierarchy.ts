import { db } from "./db.ts";
import { refOfContent, usOfContent } from "./plugins/cockpit/mirror.ts";

export function isUserStory(
  page: { kind?: string; content?: unknown[] },
): boolean {
  const content = page.content ?? [];
  return /^US-\d+$/.test(usOfContent(content) ?? "") ||
    (page.kind === "story" && !/^GEN-\d+$/.test(refOfContent(content) ?? ""));
}

/** Find the nearest linked US or outermost local story without crossing a project boundary. */
export async function storyAbove(pageId: string): Promise<string | null> {
  const pg = await db();
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
  const linked = rows.find((p) =>
    /^US-\d+$/.test(usOfContent(p.content) ?? "")
  );
  return linked?.id ?? rows.filter(isUserStory).at(-1)?.id ??
    rows.filter((p) => p.kind === "story").at(-1)?.id ?? null;
}

/** The nearest project ancestor of a page, or null. Server-side twin of the web's `projectOf`. */
export async function projectAbove(pageId: string): Promise<string | null> {
  const pg = await db();
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

export async function checkStoryParent(parentId: string | null): Promise<void> {
  if (parentId && await storyAbove(parentId)) {
    throw new Error(
      "A user story cannot be nested under another user story. Create a ticket/session or a documentation page instead.",
    );
  }
}
