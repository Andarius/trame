// The database side of mirroring. Kept apart from `mirror.ts` so the planner
// stays pure and testable without a PGlite instance.
import { db, ensureSpecsPage, listTags } from "../../db.ts";
import { createPage, deletePage, updatePage } from "../../pages.ts";
import {
  type FilingSkip,
  type MirrorPage,
  type MirrorPlan,
  refOfContent,
  stampMark,
  stampRef,
  taggedMapping,
  type TagMapping,
  US_MARK,
  usOfContent,
} from "./mirror.ts";

export type MirrorResult = {
  created: number;
  updated: number;
  removed: number;
};

type OwnedStory = {
  id: string;
  title: string;
  content: unknown[];
  tags: string[];
  status: string;
  /** the nearest live mapped ancestor */
  projectId: string;
  parentTitle: string | null;
};

/**
 * Every live story whose nearest mapped ancestor is one of `mapped`.
 *
 * A story nested under another story is still the project's, so the walk goes
 * up until it meets a mapped page — and stops there, so a project mapped
 * inside another project owns its own subtree. UNION over (story, ancestor)
 * pairs is what ends a cycle: a repeated pair adds no row, so there is no
 * depth cap to silently drop a deep-but-valid tree. The target must itself be
 * live: `parent_id` has no FK, so a deleted or missing project can still be
 * pointed at.
 */
async function storiesOwnedBy(
  mapped: readonly string[],
): Promise<OwnedStory[]> {
  const ids = [...new Set(mapped.filter(Boolean))];
  if (ids.length === 0) return [];
  const pg = await db();
  const rows = (await pg.query(
    `with recursive up(id, anc) as (
       select p.id, p.parent_id
         from pages p
        where not p.deleted and p.kind = 'story' and p.parent_id is not null
       union
       select up.id, a.parent_id
         from up join pages a on a.id = up.anc and not a.deleted
        where up.anc <> all($1::uuid[]) and a.parent_id is not null
     )
     select p.id, p.title, p.content, p.tags, p.status, up.anc as project_id,
            parent.title as parent_title
       from up
       join pages p on p.id = up.id
       join pages target on target.id = up.anc and not target.deleted
       left join pages parent on parent.id = p.parent_id
      where up.anc = any($1::uuid[])
      order by p.updated_at desc`,
    [ids],
  )).rows as {
    id: string;
    title: string;
    content: unknown;
    tags: unknown;
    status: string;
    project_id: string;
    parent_title: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: Array.isArray(r.content) ? r.content : [],
    tags: Array.isArray(r.tags) ? r.tags as string[] : [],
    status: r.status,
    projectId: r.project_id,
    parentTitle: r.parent_title,
  }));
}

/**
 * The mirrored pages a mapping's project owns, however deep they sit.
 *
 * Only pages carrying a reference mark count: a note the user wrote by hand in
 * the same project is not ours, and must never be picked up by the reconcile
 * and retired. `mapped` is every mapped project, so a project mapped inside
 * this one keeps its own pages.
 */
export async function loadMirrorPages(
  projectId: string,
  mapped: readonly string[] = [projectId],
): Promise<MirrorPage[]> {
  const out: MirrorPage[] = [];
  for (const s of await storiesOwnedBy([projectId, ...mapped])) {
    if (s.projectId !== projectId) continue;
    const ref = refOfContent(s.content);
    if (ref) {
      out.push({
        id: s.id,
        ref,
        title: s.title,
        content: s.content,
        tags: s.tags,
        status: s.status,
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

/** Stamp the user story a story page was filed as. */
export async function adoptAsUserStory(
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
  await updatePage(pageId, { content: stampMark(content, US_MARK, reference) });
}

type PageRoute = {
  mappingIndex: number;
  userStory: string | null;
  storyTitle: string | null;
} | { error: string };

/** Resolve routing through legacy nesting without crossing mapped project boundaries. */
export async function loadPageRoutes(
  mappings: TagMapping[],
): Promise<Map<string, PageRoute>> {
  const pg = await db();
  const pages = (await pg.query(
    `select id, parent_id, kind, title, tags, content from pages where not deleted`,
  )).rows as {
    id: string;
    parent_id: string | null;
    kind: string;
    title: string;
    tags: string[];
    content: unknown[];
  }[];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const mapped = new Set(mappings.map((m) => m.pageId));
  const routes = new Map<string, PageRoute>();
  for (const page of pages) {
    const chain: typeof pages = [];
    const seen = new Set<string>();
    let parent: typeof page | undefined = page;
    while (parent && !mapped.has(parent.id) && !seen.has(parent.id)) {
      seen.add(parent.id);
      chain.push(parent);
      if (parent.kind === "project") {
        parent = undefined;
        break;
      }
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    if (!parent || !mapped.has(parent.id)) continue;
    const usIndex = chain.findIndex((p) =>
      /^US-\d+$/.test(usOfContent(p.content) ?? "")
    );
    const userStory = usIndex < 0 ? null : usOfContent(chain[usIndex].content);
    if (
      usIndex < 0 &&
      chain.slice(1).some((p) => p.kind === "story" && !refOfContent(p.content))
    ) continue;
    const candidates = usIndex < 0
      ? chain.slice(0, 1)
      : chain.slice(0, usIndex + 1);
    const usMapping = usIndex < 0
      ? undefined
      : taggedMapping(mappings, parent.id, chain[usIndex].tags);
    if (usIndex >= 0 && (!usMapping || "error" in usMapping)) {
      routes.set(page.id, {
        error: usMapping && "error" in usMapping
          ? usMapping.error
          : "The nearest linked US has no valid Cockpit routing tag.",
      });
      continue;
    }
    let selected = usMapping && !("error" in usMapping) ? usMapping : undefined;
    let error: string | undefined;
    for (const candidate of candidates) {
      const explicit = taggedMapping(mappings, parent.id, candidate.tags);
      if (explicit && "error" in explicit) {
        error = explicit.error;
        break;
      }
      if (explicit && selected && explicit !== selected) {
        error = "The item's Cockpit tag conflicts with its US mapping.";
        break;
      }
      selected ??= explicit;
    }
    if (error) routes.set(page.id, { error });
    else if (selected) {
      routes.set(page.id, {
        mappingIndex: mappings.indexOf(selected),
        userStory,
        storyTitle: usIndex < 0 ? null : chain[usIndex].title,
      });
    }
  }
  return routes;
}

export type PendingSession = {
  sessionId: string;
  title: string;
  nextStep: string | null;
  status: string;
  terminal: boolean;
  userStory: string | null;
  storyTitle: string | null;
  mappingIndex: number;
  tagLabel: string;
  specs: unknown[];
};

/** Select inherited US tickets and explicitly tagged standalone tickets within live mappings. */
export async function loadPendingSessions(
  mappings: TagMapping[],
  skipped: FilingSkip[] = [],
): Promise<PendingSession[]> {
  const ids = [...new Set(mappings.map((m) => m.pageId).filter(Boolean))];
  if (!ids.length) return [];
  const routes = await loadPageRoutes(mappings);
  const pg = await db();
  const rows = (await pg.query(
    `select s.id, s.title, s.next_step, s.page_id, s.client_id, s.tags, s.status,
            coalesce(st.terminal, false) as terminal, specs.content as specs
       from sessions s
       left join pages specs on specs.id = s.specs_page_id and not specs.deleted
       left join pages project on project.id = s.client_id and not project.deleted and project.kind = 'project'
       left join statuses st on st.key = s.status and not st.deleted
      where not s.deleted and (s.page_id = any($1::uuid[])
         or (s.page_id is null and s.client_id = any($2::uuid[]) and project.id is not null))
      order by s.last_touched desc, s.id`,
    [[...routes.keys()], ids],
  )).rows as {
    id: string;
    title: string;
    next_step: string | null;
    page_id: string | null;
    client_id: string | null;
    status: string;
    terminal: boolean;
    tags: unknown;
    specs: unknown;
  }[];

  const out: PendingSession[] = [];
  for (const r of rows) {
    const specs = Array.isArray(r.specs) ? r.specs : [];
    if (refOfContent(specs)) continue;
    const route = r.page_id ? routes.get(r.page_id) : undefined;
    if (route && "error" in route) {
      skipped.push({ title: r.title, reason: route.error });
      continue;
    }
    // Attached sessions need a linked US; standalone sessions need their own tag.
    if (r.page_id && !route?.userStory) continue;
    const inherited = route ? mappings[route.mappingIndex] : undefined;
    const tags = Array.isArray(r.tags) ? r.tags as string[] : [];
    const explicit = taggedMapping(
      mappings,
      inherited?.pageId ?? r.client_id!,
      tags,
    );
    if (explicit && "error" in explicit) {
      skipped.push({ title: r.title, reason: explicit.error });
      continue;
    }
    if (inherited && explicit && inherited !== explicit) {
      skipped.push({
        title: r.title,
        reason: "The ticket's Cockpit tag conflicts with its US mapping.",
      });
      continue;
    }
    const m = inherited ?? explicit;
    if (!m) continue;
    out.push({
      sessionId: r.id,
      title: r.title,
      nextStep: r.next_step,
      status: r.status,
      terminal: r.terminal,
      userStory: route?.userStory ?? null,
      storyTitle: route?.storyTitle ?? null,
      mappingIndex: mappings.indexOf(m),
      tagLabel: m.tagLabel,
      specs,
    });
  }
  return out;
}

/** Stamp the ticket a session was filed as on its specs page, creating the page if needed. */
export async function adoptSessionAsFiled(
  sessionId: string,
  reference: string,
): Promise<void> {
  const specsId = await ensureSpecsPage(sessionId);
  await adoptAsMirror(specsId, reference);
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
      where not p.deleted
        and (p.content::text like '%trame:cockpit_ref=%'
          or p.content::text like '%trame:cockpit_us=%')
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
    const content = Array.isArray(r.content) ? r.content : [];
    const ref = usOfContent(content) ?? refOfContent(content);
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
  mappings: TagMapping[],
  skipped: FilingSkip[] = [],
): Promise<PendingPage[]> {
  const stories = await storiesOwnedBy(mappings.map((m) => m.pageId));
  const routes = await loadPageRoutes(mappings);
  return stories.flatMap((page) => {
    if (refOfContent(page.content) || usOfContent(page.content)) return [];
    const route = routes.get(page.id);
    if (!route) return [];
    if ("error" in route) {
      skipped.push({ title: page.title, reason: route.error });
      return [];
    }
    return [{
      pageId: page.id,
      title: page.title,
      parentTitle: page.parentTitle,
      tagLabel: mappings[route.mappingIndex].tagLabel,
    }];
  });
}

/** The nearest live page of `candidates` above `pageId`, or null. */
export async function mappedProjectOf(
  pageId: string,
  candidates: readonly string[],
): Promise<string | null> {
  const ids = [...new Set(candidates.filter(Boolean))];
  if (ids.length === 0) return null;
  const pg = await db();
  const rows = (await pg.query(
    `with recursive up(anc) as (
       select parent_id from pages where id = $1 and not deleted
       union
       select a.parent_id
         from up join pages a on a.id = up.anc and not a.deleted
        where up.anc <> all($2::uuid[])
     )
     select target.id
       from up join pages target on target.id = up.anc and not target.deleted
      where up.anc = any($2::uuid[])
      limit 1`,
    [pageId, ids],
  )).rows as { id: string }[];
  return rows[0]?.id ?? null;
}

export type TagSyncItem = {
  reference: string;
  sourceId: string;
  title: string;
  tags: string[];
  mappingIndex: number;
};

/** Read tags from mapped exported pages or their session, resolving current display labels. */
export async function loadTagSyncItems(
  mappings: TagMapping[],
): Promise<TagSyncItem[]> {
  const projectIds = [
    ...new Set(mappings.map((m) => m.pageId).filter(Boolean)),
  ];
  if (!projectIds.length) return [];
  const pg = await db();
  const [pagesResult, sessionsResult, catalogue] = await Promise.all([
    pg.query(
      `select id, title, parent_id, tags, content from pages where not deleted`,
    ),
    pg.query(
      `select id, title, page_id, client_id, specs_page_id, tags from sessions where not deleted and specs_page_id is not null`,
    ),
    listTags(),
  ]);
  type Page = {
    id: string;
    title: string;
    parent_id: string | null;
    tags: string[];
    content: unknown[];
  };
  type Session = {
    id: string;
    title: string;
    page_id: string | null;
    client_id: string | null;
    specs_page_id: string;
    tags: string[];
  };
  const pages = new Map(
    (pagesResult.rows as Page[]).map((page) => [page.id, page]),
  );
  const sessions = new Map<string, Session[]>();
  for (const session of sessionsResult.rows as Session[]) {
    sessions.set(session.specs_page_id, [
      ...(sessions.get(session.specs_page_id) ?? []),
      session,
    ]);
  }
  const labels = new Map(
    (catalogue as { key: string; label: string }[]).map((
      tag,
    ) => [tag.key, tag.label]),
  );
  const out: TagSyncItem[] = [];
  for (const page of pages.values()) {
    const reference = usOfContent(page.content) ?? refOfContent(page.content);
    if (!reference || !/^(GEN|US)-\d+$/.test(reference)) continue;
    const owners = reference.startsWith("GEN-")
      ? sessions.get(page.id) ?? [undefined]
      : [undefined];
    for (const session of owners) {
      const ancestors: Page[] = [];
      const start = session
        ? session.page_id ?? session.client_id
        : page.parent_id;
      let cursor = pages.get(start ?? "");
      const seen = new Set([page.id]);
      while (cursor && !seen.has(cursor.id)) {
        ancestors.push(cursor);
        if (projectIds.includes(cursor.id)) break;
        seen.add(cursor.id);
        cursor = pages.get(cursor.parent_id ?? "");
      }
      const project = ancestors.at(-1);
      if (!project || !projectIds.includes(project.id)) continue;
      const keys = session?.tags ?? page.tags;
      const ownMapping = taggedMapping(mappings, project.id, keys);
      if (ownMapping && "error" in ownMapping) continue;
      let inherited: ReturnType<typeof taggedMapping>;
      for (const ancestor of ancestors) {
        inherited = taggedMapping(mappings, project.id, ancestor.tags);
        if (inherited) break;
      }
      if (inherited && "error" in inherited) continue;
      if (ownMapping && inherited && ownMapping !== inherited) continue;
      const mapping = ownMapping ?? inherited;
      if (!mapping) continue;
      // `trame` always rides along: a ticket filed from here is recognisable in
      // Cockpit even when its session carries no tag of its own.
      const tags = [
        ...new Set(["trame", ...keys.flatMap((key) => {
          const label = labels.get(key);
          return !label || /^cockpit-/i.test(key) || /^cockpit\s*:/i.test(label)
            ? []
            : [label];
        })]),
      ].sort();
      out.push({
        reference,
        sourceId: `trame:${session ? `session:${session.id}` : page.id}`,
        title: session?.title ?? page.title,
        tags,
        mappingIndex: mappings.indexOf(mapping),
      });
    }
  }
  return out;
}
