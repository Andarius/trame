// The database side of mirroring. Kept apart from `mirror.ts` so the planner
// stays pure and testable without a PGlite instance.
import { db } from "../../db.ts";
import { createPage, deletePage, updatePage } from "../../pages.ts";
import {
  type MirrorPage,
  type MirrorPlan,
  pendingOf,
  refOfContent,
  stampRef,
} from "./mirror.ts";

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
    `select id, title, content, tags, status from pages
      where parent_id = $1 and kind = 'story' and not deleted`,
    [parentId],
  )).rows as {
    id: string;
    title: string;
    content: unknown;
    tags: unknown;
    status: string;
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
        status: r.status,
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
      status: c.status,
    });
  }
  for (const u of plan.update) {
    await updatePage(u.id, {
      title: u.title,
      content: u.blocks,
      tags: u.tags,
      status: u.status,
    });
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

/**
 * Turn a local page into a mirrored one, once Cockpit has given it a
 * reference. Stamping the mark is what makes the next poll recognise the page
 * as ours and keep it in step, instead of creating a second page beside it.
 */
export async function adoptAsMirror(
  pageId: string,
  reference: string,
): Promise<void> {
  const pg = await db();
  const row = (await pg.query(
    `select content from pages where id=$1 and not deleted`,
    [pageId],
  )).rows[0] as { content: unknown } | undefined;
  if (!row) throw new Error(`unknown page ${pageId}`);

  const content = Array.isArray(row.content) ? row.content : [];
  await updatePage(pageId, { content: stampRef(content, reference) });
}

export type SyncedPage = {
  pageId: string;
  ref: string;
  title: string;
  parentTitle: string | null;
  updatedAt: string;
};

/**
 * Every page that stands for a Cockpit ticket, wherever it lives.
 *
 * Deliberately not scoped to the mappings: a page filed from a project you
 * later unmapped is still a page that reached Cockpit, and hiding it would
 * answer "what did I sync?" with a comfortable lie. The `like` is only a
 * prefilter — `refOfContent` decides.
 */
export async function loadSyncedPages(): Promise<SyncedPage[]> {
  const pg = await db();
  const rows = (await pg.query(
    `select p.id, p.title, p.content, p.updated_at, parent.title as parent_title
       from pages p
       left join pages parent on parent.id = p.parent_id and not parent.deleted
      where not p.deleted and p.content::text like '%trame:cockpit_ref=%'
      order by p.updated_at desc`,
  )).rows as {
    id: string;
    title: string;
    content: unknown;
    updated_at: string;
    parent_title: string | null;
  }[];

  const out: SyncedPage[] = [];
  for (const r of rows) {
    const ref = refOfContent(Array.isArray(r.content) ? r.content : []);
    if (!ref) continue;
    out.push({
      pageId: r.id,
      ref,
      title: r.title,
      parentTitle: r.parent_title,
      updatedAt: new Date(r.updated_at).toISOString(),
    });
  }
  return out;
}

export type PendingPage = {
  pageId: string;
  title: string;
  parentTitle: string | null;
  tagLabel: string;
};

/**
 * Pages tagged for a mapping but not filed yet — the push side's inbox.
 *
 * A page already carrying a reference is not pending, however it got one:
 * mirrored from Cockpit, or filed from another device. Without that the panel
 * would keep offering to file pages that came FROM Cockpit.
 */
export async function loadPendingPages(
  mappings: { pageId: string; tagKey: string; tagLabel: string }[],
): Promise<PendingPage[]> {
  const parents = [...new Set(mappings.map((m) => m.pageId).filter(Boolean))];
  if (parents.length === 0) return [];

  const pg = await db();
  // Every live story with its nearest mapped ancestor: a story nested under
  // another story is still the project's, so the walk stops at the first hit.
  const rows = (await pg.query(
    `with recursive up as (
       select p.id, p.parent_id as anc, 1 as depth
         from pages p
        where not p.deleted and p.kind = 'story' and p.parent_id is not null
       union all
       select up.id, a.parent_id, up.depth + 1
         from up join pages a on a.id = up.anc and not a.deleted
        where up.anc <> all($1::uuid[]) and a.parent_id is not null and up.depth < 32
     )
     select p.id, p.title, p.tags, p.content, up.anc as project_id,
            parent.title as parent_title
       from up
       join pages p on p.id = up.id
       left join pages parent on parent.id = p.parent_id
      where up.anc = any($1::uuid[])
      order by p.updated_at desc`,
    [parents],
  )).rows as {
    id: string;
    title: string;
    tags: unknown;
    content: unknown;
    project_id: string;
    parent_title: string | null;
  }[];

  return pendingOf(
    rows.map((r) => ({
      pageId: r.id,
      projectId: r.project_id,
      tags: Array.isArray(r.tags) ? r.tags as string[] : [],
      content: Array.isArray(r.content) ? r.content : [],
      title: r.title,
      parentTitle: r.parent_title,
    })),
    mappings,
  ).map(({ page, tagLabel }) => ({
    pageId: page.pageId,
    title: page.title,
    parentTitle: page.parentTitle,
    tagLabel,
  }));
}

/** The nearest of `candidates` above `pageId`, or null when none is an ancestor. */
export async function mappedProjectOf(
  pageId: string,
  candidates: readonly string[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const pg = await db();
  const rows = (await pg.query(
    `with recursive up as (
       select parent_id as anc, 1 as depth from pages where id = $1 and not deleted
       union all
       select a.parent_id, up.depth + 1
         from up join pages a on a.id = up.anc and not a.deleted
        where up.anc <> all($2::uuid[]) and up.depth < 32
     )
     select anc from up where anc = any($2::uuid[]) limit 1`,
    [pageId, [...candidates]],
  )).rows as { anc: string }[];
  return rows[0]?.anc ?? null;
}
