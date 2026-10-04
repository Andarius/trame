import { v5 } from "@std/uuid";
import type { Ctx, Q } from "./ctx.ts";
import { checkStoryParent, projectAbove, storyAbove } from "./hierarchy.ts";
import { pageBlocksToMarkdown } from "./page-markdown.ts";
import { midKey } from "./sort-key.ts";
import { similarStories, STORY_REUSE } from "./story-match.ts";
import { tagColor, tagKey } from "./tags.ts";

// deleted: true returns the soft-deleted sessions instead of the live ones
export async function getBoard(ctx: Ctx, { deleted = false }: { deleted?: boolean } = {}) {
  const pg = ctx.q;
  // Project > Story > Session. "projects" = top-level Project pages (shape {id,name,color}
  // for the chip/sidebar); "stories" = Story pages (what sessions ladder to).
  const projects = (await pg.query(
    `select id, title as name, color, icon from pages where kind='project' and not deleted order by title`,
  )).rows;
  const stories = (await pg.query(`select * from pages where kind='story' and not deleted order by title`)).rows;
  const sessions = (await pg.query(
    `select * from sessions where deleted = $1 order by last_touched desc`,
    [deleted],
  )).rows;
  const pages = (await pg.query(
    `select id, parent_id, kind, title, icon, client_id, color, tags from pages where not deleted order by title`,
  )).rows;
  const statuses = (await pg.query(
    `select id, key, label, color, terminal, sort_key from statuses where not deleted order by sort_key`,
  )).rows;
  return { projects, stories, sessions, pages, statuses };
}

const PALETTE = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567"];

// owner_id for page inserts, resolved from the origin param already in the statement
// (a subquery, not identity.ts, to keep db.ts free of an import cycle). Null while
// the device is unclaimed.
const OWNER_ID_SQL = (originParam: number) =>
  `(select user_id from devices where node_id=$${originParam} and not deleted limit 1)`;

// "client" is now the top-level Project page — find-or-create by title.
export async function resolveClient(ctx: Ctx, name: string, color?: string): Promise<string> {
  const pg = ctx.q;
  const hit = (await pg.query(
    `select id from pages where kind='project' and title=$1 and not deleted limit 1`,
    [name],
  )).rows[0] as { id: string } | undefined;
  if (hit) return hit.id;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const col = color ?? PALETTE[Math.abs(h) % PALETTE.length];
  const row = (await pg.query(
    `insert into pages (kind, title, color, origin, owner_id)
     values ('project',$1,$2,$3,${OWNER_ID_SQL(3)}) returning id`,
    [name, col, ctx.origin],
  )).rows[0] as { id: string };
  return row.id;
}

// Home project for a page an agent creates from a repo: the project of the session that
// owns this path, else a project whose title is a path segment, else Side-projects. Keeps
// agent-authored pages out of the Unfiled inbox.
export async function resolveHomeProject(ctx: Ctx, repoPath: string): Promise<string | null> {
  const path = repoPath.replace(/\/+$/, "");
  if (!path) return null;
  const pg = ctx.q;
  const bySession = (await pg.query(
    `select client_id from sessions
      where not deleted and client_id is not null and repo_path is not null
        and starts_with($1 || '/', repo_path || '/')
      order by length(repo_path) desc, last_touched desc limit 1`,
    [path],
  )).rows[0] as { client_id: string } | undefined;
  if (bySession) return bySession.client_id;
  const byPath = (await pg.query(
    `select id from pages where kind='project' and not deleted and position('/' || title || '/' in $1) > 0
     order by length(title) desc limit 1`,
    [path + "/"],
  )).rows[0] as { id: string } | undefined;
  return byPath ? byPath.id : await resolveClient(ctx, "Side-projects");
}

// A Story is a kind='story' page nested under its Project (clientId). Find-or-create by
// title — trimmed, case- and whitespace-insensitive, so wording drift does not mint a
// duplicate. Another project's stories are off-limits; an unfiled plain page is still
// reused (and promoted on attach) rather than duped. Exact spelling, then a story, then
// the caller's own project win the tie.
// The find half of resolveStory: the page a story title names, or null. Never creates.
async function findStory(ctx: Ctx, title: string, clientId: string | null): Promise<string | null> {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const pg = ctx.q;
  const hit = (await pg.query(
    `select id from pages
      where kind in ('story','page') and not deleted
        and lower(regexp_replace(trim(title), '\\s+', ' ', 'g')) = lower($1)
        and ($2::uuid is null or client_id = $2 or client_id is null)
      order by (title = $1) desc, (kind='story') desc,
               (client_id is not distinct from $2::uuid) desc, updated_at desc
      limit 1`,
    [clean, clientId],
  )).rows[0] as { id: string } | undefined;
  return hit?.id ?? null;
}

async function openStories(ctx: Ctx, clientId: string | null): Promise<{ id: string; title: string }[]> {
  return (await ctx.q.query(
    `select id, title from pages where kind='story' and status='open' and not deleted
        and ($1::uuid is null or client_id = $1)`,
    [clientId],
  )).rows as { id: string; title: string }[];
}

// Where resolveStory reports a near-duplicate it reused or found.
export type StoryNote = { story_note?: string };

// The read-only half of resolveStory: exact title, else a near-duplicate open story.
async function matchStory(ctx: Ctx, title: string, clientId: string | null, out?: StoryNote): Promise<string | null> {
  const exact = await findStory(ctx, title, clientId);
  if (exact) return exact;
  const [best] = similarStories(title, await openStories(ctx, clientId), STORY_REUSE);
  if (!best) return null;
  if (out) out.story_note = `matched existing story '${best.title}' (${best.score})`;
  return best.id;
}

// Open stories similar to `q` with their open-card counts; the project comes from its
// name, else from the repo path. Never creates anything.
export async function findSimilarStories(ctx: Ctx, q: string, o: { client?: string; repo_path?: string }, limit = 5) {
  const pg = ctx.q;
  const clientId = o.client
    ? ((await pg.query(`select id from pages where kind='project' and title=$1 and not deleted limit 1`, [o.client]))
      .rows[0] as { id: string } | undefined)?.id ?? null
    : o.repo_path
    ? await resolveHomeProject(ctx, o.repo_path)
    : null;
  const hits = similarStories(q, await openStories(ctx, clientId)).slice(0, limit);
  const counts = new Map(
    ((await pg.query(
      `select page_id, count(*)::int as n from sessions
        where not deleted and page_id = any($1::uuid[])
          and status not in (select key from statuses where terminal and not deleted)
        group by page_id`,
      [hits.map((h) => h.id)],
    )).rows as { page_id: string; n: number }[]).map((r) => [r.page_id, r.n]),
  );
  return hits.map((h) => ({ ...h, open_cards: counts.get(h.id) ?? 0 }));
}

export async function resolveStory(
  ctx: Ctx,
  title: string,
  clientId: string | null,
  tags: string[] = [],
  out?: StoryNote,
): Promise<string> {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("a story needs a title");
  const pg = ctx.q;
  const hit = await matchStory(ctx, clean, clientId, out);
  if (hit) return hit;
  const near = similarStories(clean, await openStories(ctx, clientId)).slice(0, 3);
  if (out && near.length) {
    out.story_note = `similar open stories: ${near.map((n) => `'${n.title}' (${n.score})`).join(", ")}; ` +
      "re-track with one of them if it is the same topic";
  }
  await checkStoryParent(ctx, clientId);
  // default tags (TRACKER_CLIENTS) stamp NEW stories only — an existing page's tags
  // belong to the user
  const keys: string[] = [];
  for (const label of tags) keys.push((await ensureTag(ctx, { label })).key);
  const row = (await pg.query(
    `insert into pages (kind, title, client_id, parent_id, tags, origin, owner_id)
     values ('story',$1,$2,$2,$3,$4,${OWNER_ID_SQL(4)}) returning id`,
    [clean, clientId, JSON.stringify(keys), ctx.origin],
  )).rows[0] as { id: string };
  return row.id;
}

export async function createStory(ctx: Ctx, o: { title: string; brief?: string; client?: string }): Promise<string> {
  const pg = ctx.q;
  const clientId = o.client ? await resolveClient(ctx, o.client) : null;
  await checkStoryParent(ctx, clientId);
  const row = (await pg.query(
    `insert into pages (kind, title, brief, client_id, parent_id, origin, owner_id)
     values ('story',$1,$2,$3,$3,$4,${OWNER_ID_SQL(4)}) returning id`,
    [o.title, o.brief ?? "", clientId, ctx.origin],
  )).rows[0] as { id: string };
  return row.id;
}

// Attaching a session promotes a plain page to a Story (one-way), nesting it under its
// Project if one was given. Projects themselves are never demoted to stories.
async function promoteToProject(ctx: Ctx, pageId: string, clientId: string | null): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update pages set kind='story', client_id=coalesce(client_id,$2), parent_id=coalesce(parent_id,$2),
       origin=$3, updated_at=clock_timestamp()
      where id=$1 and kind='page' and not deleted`,
    [pageId, clientId, ctx.origin],
  );
}

// Deterministic per-session spec-page id: independent nodes find-or-create the SAME
// row, so whole-row LWW converges without coordination (same trick as statusId).
const SPECS_NS = "b2f6c1d8-4e5a-4b7c-8f1d-2a9e6c3b0d47";
export const specsPageId = (sessionId: string) =>
  v5.generate(SPECS_NS, new TextEncoder().encode(sessionId));

// Find-or-create the session's spec page: a subpage of the story (fallback: the
// project page, else detached), titled after the session. Resurrects a deleted one.
export async function ensureSpecsPage(ctx: Ctx, sessionId: string): Promise<string> {
  const pg = ctx.q;
  const s = (await pg.query(
    `select title, client_id, page_id, specs_page_id from sessions where id=$1 and not deleted`,
    [sessionId],
  )).rows[0] as {
    title: string;
    client_id: string | null;
    page_id: string | null;
    specs_page_id: string | null;
  } | undefined;
  if (!s) throw new Error(`unknown session ${sessionId}`);
  if (s.specs_page_id) {
    const live = (await pg.query(`select 1 from pages where id=$1 and not deleted`, [s.specs_page_id])).rows[0];
    if (live) return s.specs_page_id;
  }
  const id = await specsPageId(sessionId);
  await pg.query(
    `insert into pages (id, kind, title, client_id, parent_id, origin, owner_id)
     values ($1,'page',$2,$3,$4,$5,${OWNER_ID_SQL(5)})
     on conflict (id) do update set deleted=false, origin=$5, updated_at=clock_timestamp()
     where pages.deleted`,
    [id, `Specs — ${s.title}`, s.client_id, s.page_id ?? s.client_id, ctx.origin],
  );
  await pg.query(
    `update sessions set specs_page_id=$2, origin=$3, updated_at=clock_timestamp() where id=$1`,
    [sessionId, id, ctx.origin],
  );
  return id;
}

// A page becomes a card: the page itself is the card's specs, so a plan written by hand
// IS the ticket. Anchored to the story ABOVE the page, never the page itself — anchoring
// promotes a plain page to a story one-way (promoteToProject) and a spec page must not
// double as its own story. Deterministic id, same reason as specsPageId: two nodes
// converting the same page converge on one card instead of forking two.
const PAGE_CARD_NS = "9c1f4a02-7d3e-4c85-b6a1-0e58d2f7c934";

export async function sessionFromPage(
  ctx: Ctx,
  pageId: string,
): Promise<{ id: string; created: boolean }> {
  const pg = ctx.q;
  const page = (await pg.query(
    `select title, kind, parent_id, client_id from pages where id=$1 and not deleted`,
    [pageId],
  )).rows[0] as
    | { title: string; kind: string; parent_id: string | null; client_id: string | null }
    | undefined;
  if (!page) throw new Error(`unknown page ${pageId}`);
  if (page.kind !== "page") {
    throw new Error("a project or a story is where cards live, not a card's specs");
  }
  // any live card already speccing this page wins — including one ensureSpecsPage
  // generated, which makes the caller's button a way back from any spec page
  const hit = (await pg.query(
    `select id from sessions where specs_page_id=$1 and not deleted limit 1`,
    [pageId],
  )).rows[0] as { id: string } | undefined;
  if (hit) return { id: hit.id, created: false };

  const anchor = page.parent_id ? await storyAbove(ctx, page.parent_id) : null;
  const id = await upsertSession(ctx, {
    // explicit: the three adoption lookups are all guarded by `!s.id`, and this card
    // must never adopt (or be mistaken for) work already tracked elsewhere
    id: await v5.generate(PAGE_CARD_NS, new TextEncoder().encode(pageId)),
    title: page.title.trim() || "Untitled",
    // a plain page rarely carries client_id (only stories keep it) — walk for it, else
    // an anchorless card lands on the board with no project at all
    client_id: page.client_id ?? await projectAbove(ctx, pageId),
    page_id: anchor,
  });
  // specs_page_id is not in upsertSession's column list; `deleted` is not in its
  // on-conflict list either, so converting again after deleting the card resurrects it
  await pg.query(
    `update sessions set specs_page_id=$2, deleted=false, origin=$3, updated_at=clock_timestamp()
      where id=$1`,
    [id, pageId, ctx.origin],
  );
  return { id, created: true };
}

// Columns are user-editable, but the session default, the importers and the tracking
// skills all still emit fixed keys ('active'…) — park an unknown one on a surviving
// column, else the card renders in no column at all.
async function resolveStatusKey(pg: Q, key: unknown): Promise<string> {
  const want = typeof key === "string" && key ? key : "active";
  const rows = (await pg.query(
    `select key from statuses where not deleted order by terminal, sort_key`,
  )).rows as { key: string }[];
  if (!rows.length) return want; // not seeded yet — keep the caller's key
  return rows.some((r) => r.key === want) ? want : rows[0].key;
}

export class SessionTagsError extends Error {}

// Newline lists (branches, pr_url): drop blanks and dupes, the incoming items last.
function mergeLines(cur: unknown, add: unknown): string {
  const lines = (v: unknown) => typeof v === "string" ? v.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const incoming = lines(add);
  return [...lines(cur).filter((l) => !incoming.includes(l)), ...incoming].join("\n");
}

const OPEN_SESSION = `not deleted and status not in (select key from statuses where terminal and not deleted)`;

// `out` receives a story_note when the story matched or resembles an existing one.
export async function upsertSession(ctx: Ctx, s: Record<string, unknown>, out?: StoryNote): Promise<string> {
  const explicitId = Boolean(s.id);
  if (s.tags !== undefined && (!Array.isArray(s.tags) ||
    s.tags.some((tag) => typeof tag !== "string" || !tag.trim()))) {
    throw new SessionTagsError("tags must be an array of non-empty tag keys");
  }
  // A label (`cockpit:devops`) slugs to the same key a page stores; storing it raw
  // would make the session invisible to every key-based lookup.
  if (Array.isArray(s.tags)) s.tags = [...new Set((s.tags as string[]).map(tagKey))];
  const pg = ctx.q;
  // claude_id is the column name; the public writer says agent_id (Claude or Codex).
  s.claude_id ??= s.agent_id;
  if (s.claude_id && !s.agent) s.agent = "claude";
  // Accept human names (from the CLI/MCP) and resolve them to ids.
  if (typeof s.client === "string" && !s.client_id) s.client_id = await resolveClient(ctx, s.client);
  // One agent session + story = one card, whatever the branch or repo: new branches and
  // PRs attach to it. Without a story, the session's open card on this branch (or an
  // unbranched import) is the match. A done card is never resurrected.
  const story = typeof s.story === "string" && s.story.trim() ? s.story : null;
  if (!s.id && s.claude_id) {
    const matched = story ? await matchStory(ctx, story, (s.client_id as string) ?? null, out) : null;
    // cards anchor to the story above (below): a nested story must look there too
    const storyId = matched ? await storyAbove(ctx, matched) ?? matched : null;
    const hit = storyId
      ? (await pg.query(
        `select id from sessions where (claude_id=$1 or id=$1) and page_id=$2 and ${OPEN_SESSION}
         order by last_touched desc limit 1`,
        [s.claude_id, storyId],
      )).rows[0] as { id: string } | undefined
      : story
      ? undefined // a story not seen yet: a new card
      : (await pg.query(
        `select id from sessions where (claude_id=$1 or id=$1) and ${OPEN_SESSION}
           and ($2 = '' or coalesce(branches,'') = '' or $2 = any(string_to_array(branches, E'\\n')))
         order by last_touched desc limit 1`,
        [s.claude_id, (s.branch as string) ?? ""],
      )).rows[0] as { id: string } | undefined;
    if (hit) s.id = hit.id;
  }
  // Upsert by (repo_path, branch) among open sessions when no id is given, the branch
  // matched against every branch the card shipped. "Open" = any non-terminal status
  // (done-like statuses are user-defined, so ask the statuses table). A known session
  // only adopts unlinked cards here: its own cards were matched above, by story.
  if (!s.id && s.repo_path) {
    const hit = (await pg.query(
      `select id from sessions where repo_path=$1 and ${OPEN_SESSION}
         and (coalesce(branch,'')=$2 or $2 = any(string_to_array(branches, E'\\n')))
         and ($3::uuid is null or claude_id is null)
       order by last_touched desc limit 1`,
      [s.repo_path, (s.branch as string) ?? "", s.claude_id ?? null],
    )).rows[0] as { id: string } | undefined;
    if (hit) s.id = hit.id;
  }
  // Still nothing: PLANNED work — an unbranched open card on this repo — adopts the
  // first branch tracked for it, in the spirit of the transcript rule above, but scoped
  // by the story anchor so unrelated work on the repo cannot hijack a plan: an anchored
  // plan only matches a track naming the same story; an unanchored one matches any.
  if (!s.id && s.repo_path && (s.branch as string)) {
    const planned = (await pg.query(
      `select id, page_id from sessions where repo_path=$1 and coalesce(branch,'')='' and not deleted
         and status not in (select key from statuses where terminal and not deleted)
       order by last_touched desc`,
      [s.repo_path],
    )).rows as { id: string; page_id: string | null }[];
    if (planned.length) {
      const storyId = typeof s.story === "string"
        ? await findStory(ctx, s.story, (s.client_id as string) ?? null)
        : null;
      const hit = planned.find((p) => !p.page_id || p.page_id === storyId);
      if (hit) s.id = hit.id;
    }
  }
  // Resolve the story name only now, with the session KNOWN: an attached session keeps
  // its page whatever the wording — only an explicit page_id (the drawer) retargets.
  // Resolving before the lookup minted a fresh story on every rewording and orphaned
  // the old one.
  if (s.page_id === undefined && typeof s.story === "string" && s.story.trim()) {
    const cur = s.id
      ? (await pg.query(`select page_id from sessions where id=$1 and not deleted`, [s.id]))
        .rows[0] as { page_id: string | null } | undefined
      : undefined;
    if (!cur?.page_id) {
      const tags = typeof s.repo_path === "string" ? (ctx.defaultTags?.(s.repo_path) ?? []) : [];
      s.page_id = await resolveStory(ctx, s.story, (s.client_id as string) ?? null, tags, out);
    }
  }
  // project = a page that has sessions: attaching promotes a plain page (one-way)
  if (s.page_id) {
    s.page_id = await storyAbove(ctx, s.page_id as string) ?? s.page_id;
    await promoteToProject(ctx, s.page_id as string, (s.client_id as string) ?? null);
  }
  const id = (s.id as string) ?? crypto.randomUUID();
  // A matched card accumulates branches and PRs; an explicit id (the drawer) sets pr_url
  // as given, so removing a PR there sticks.
  const cur = s.id
    ? (await pg.query(`select branch, branches, pr_url from sessions where id=$1`, [s.id]))
      .rows[0] as { branch: string | null; branches: string | null; pr_url: string | null } | undefined
    : undefined;
  if (cur && !explicitId) {
    s.branch ??= cur.branch;
    s.pr_url = mergeLines(cur.pr_url, s.pr_url) || null;
  }
  const branches = mergeLines(cur?.branches, s.branch);
  // Transcript linkage: null never clobbers (UI edits omit it); a fresh value wins.
  // page_id is tri-state: absent = keep (a track call is not a detach), null = detach.
  await pg.query(
    `insert into sessions
       (id,title,status,client_id,page_id,repo_path,branch,next_step,pr_url,summary,claude_id,agent,last_touched,origin,updated_at,tags,branches)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13,clock_timestamp(),$11,clock_timestamp(),$16::jsonb,$17)
     on conflict (id) do update set
       title=$2,status=$3,client_id=$4,repo_path=$6,branch=$7,branches=$17,
       page_id=case when $14 then $5 else sessions.page_id end,
       tags=case when $15 then excluded.tags else sessions.tags end,
       next_step=$8,pr_url=$9,summary=$10,claude_id=coalesce($12,sessions.claude_id),
       agent=coalesce($13,sessions.agent),
       last_touched=clock_timestamp(),origin=$11,updated_at=clock_timestamp()`,
    [id, s.title, await resolveStatusKey(pg, s.status), s.client_id ?? null, s.page_id ?? null,
      s.repo_path ?? null, s.branch ?? null, s.next_step ?? null, s.pr_url ?? null, s.summary ?? "", ctx.origin,
      s.claude_id ?? null, s.agent ?? null, s.page_id !== undefined,
      s.tags !== undefined, JSON.stringify(s.tags ?? []), branches],
  );
  return id;
}

// Quick-find (Ctrl+P): one ranked list across sessions, pages, and databases.
// Empty query = "recently touched" (title ilike '%%' is true for non-null titles).
// kind 'client' = a Project page (opens the client view); 'page' covers stories/pages.
export async function searchAll(ctx: Ctx, q: string) {
  const pg = ctx.q;
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return (await pg.query(
    `select * from (
       select 'session' as kind, id::text as id, title, coalesce(summary,'') as sub,
              '' as icon, status as meta, '' as color, last_touched as at
         from sessions
        where not deleted and (title ilike $1 or summary ilike $1 or coalesce(next_step,'') ilike $1)
       union all
       select case when kind='project' then 'client' else 'page' end, id::text, title,
              coalesce(brief,''), coalesce(icon,''), kind, coalesce(color,''), updated_at
         from pages
        where not deleted and (title ilike $1 or brief ilike $1 or content::text ilike $1)
       union all
       select 'database', id::text, name, '', coalesce(icon,''), 'database', '', updated_at
         from udb_databases
        where not deleted and name ilike $1
     ) hits
     order by at desc
     limit 20`,
    [pat],
  )).rows;
}

export async function setSessionStatus(ctx: Ctx, id: string, status: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(`update sessions set status=$2, origin=$3, updated_at=clock_timestamp() where id=$1`, [id, status, ctx.origin]);
}

// tags (free labels on pages)

const TAG_NS = "3c9e0b71-2f45-4d18-a6c3-8e5417b9d0aa";
export const tagId = (key: string) => v5.generate(TAG_NS, new TextEncoder().encode(key));

// Re-exported: the slug rule now lives in tags.ts, which the web bundle can import too.
export { tagKey };

// Find-or-create a tag by label. Unlike a status, a clash is the POINT: two people
// typing "DevOps" must land on ONE tag, not on `devops-2`. The id falls out of the key
// (same reason schema.sql seeds the built-in statuses with fixed ids), so two offline
// nodes converge instead of forking; `do update` revives one deleted earlier.
export async function ensureTag(ctx: Ctx, t: { label: string; color?: string }): Promise<{ id: string; key: string }> {
  const pg = ctx.q;
  const key = tagKey(t.label) || "tag";
  const id = await tagId(key);
  const last = (await pg.query(`select max(sort_key) as k from tags where not deleted`)).rows[0] as { k: string | null };
  await pg.query(
    `insert into tags (id, key, label, color, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set
       label=excluded.label, deleted=false, origin=excluded.origin, updated_at=clock_timestamp()`,
    [id, key, t.label, t.color ?? tagColor(key), midKey(last.k ?? "", ""), ctx.origin],
  );
  return { id, key };
}

export async function listTags(ctx: Ctx) {
  const pg = ctx.q;
  return (await pg.query(
    `select id, key, label, color, sort_key from tags where not deleted order by sort_key, label`,
  )).rows;
}

// key is immutable (pages.tags references it) — only label/color are patchable
export async function updateTag(ctx: Ctx, id: string, patch: { label?: string; color?: string }): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update tags set label=coalesce($2,label), color=coalesce($3,color), origin=$4, updated_at=clock_timestamp() where id=$1`,
    [id, patch.label ?? null, patch.color ?? null, ctx.origin],
  );
}

// Soft-delete the vocabulary row. Pages keep the key and render it plainly.
export async function deleteTag(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(`update tags set deleted=true, origin=$2, updated_at=clock_timestamp() where id=$1`, [id, ctx.origin]);
}

// statuses (kanban columns)

// slug a label into a key, unique among non-deleted statuses (append -2, -3, … on clash)
async function uniqueStatusKey(pg: Q, label: string): Promise<string> {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "status";
  const taken = new Set(
    ((await pg.query(`select key from statuses where not deleted`)).rows as { key: string }[]).map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Two offline nodes adding the same label must converge on ONE column: derive the id from
// the key, the same reason schema.sql seeds the built-ins with fixed ids. `do update` also
// revives a status whose key was deleted earlier.
const STATUS_NS = "6f1d4a2e-8c3b-4f9a-9d2e-5b7c1a0e3f84";
export const statusId = (key: string) => v5.generate(STATUS_NS, new TextEncoder().encode(key));

export async function createStatus(ctx: Ctx, s: { label: string; color: string; terminal?: boolean }): Promise<string> {
  const pg = ctx.q;
  const key = await uniqueStatusKey(pg, s.label);
  const last = (await pg.query(`select max(sort_key) as k from statuses where not deleted`)).rows[0] as { k: string | null };
  const id = await statusId(key);
  await pg.query(
    `insert into statuses (id, key, label, color, terminal, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       label=$3, color=$4, terminal=$5, sort_key=$6, deleted=false, origin=$7, updated_at=clock_timestamp()`,
    [id, key, s.label, s.color, s.terminal ?? false, midKey(last.k ?? "", ""), ctx.origin],
  );
  return id;
}

// key is immutable (sessions reference it) — only label/color/terminal are patchable
export async function updateStatus(
  ctx: Ctx,
  id: string,
  patch: { label?: string; color?: string; terminal?: boolean },
): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update statuses set label=coalesce($2,label), color=coalesce($3,color),
       terminal=coalesce($4,terminal), origin=$5, updated_at=clock_timestamp() where id=$1`,
    [id, patch.label ?? null, patch.color ?? null, patch.terminal ?? null, ctx.origin],
  );
}

// reorder by one slot: swap sort_keys with the adjacent neighbor
export async function moveStatus(ctx: Ctx, id: string, dir: -1 | 1): Promise<void> {
  const pg = ctx.q;
  const rows = (await pg.query(
    `select id, sort_key from statuses where not deleted order by sort_key`,
  )).rows as { id: string; sort_key: string }[];
  const i = rows.findIndex((r) => r.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return;
  await pg.query(
    `update statuses set sort_key = case id when $1 then $4 when $2 then $3 else sort_key end,
       origin=$5, updated_at=clock_timestamp() where id in ($1,$2)`,
    [rows[i].id, rows[j].id, rows[i].sort_key, rows[j].sort_key, ctx.origin],
  );
}

// soft-delete; reassign any sessions on this status to a fallback so no card is orphaned.
// refuses to delete the last remaining status.
export async function deleteStatus(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  const all = (await pg.query(
    `select id, key, terminal from statuses where not deleted order by (terminal) asc, sort_key`,
  )).rows as { id: string; key: string; terminal: boolean }[];
  const victim = all.find((s) => s.id === id);
  if (!victim) return;
  if (all.length <= 1) throw new Error("cannot delete the last status");
  const fallback = all.find((s) => s.id !== id); // first non-terminal by the ordering above
  await pg.query(
    `update sessions set status=$2, origin=$3, updated_at=clock_timestamp() where status=$1 and not deleted`,
    [victim.key, fallback!.key, ctx.origin],
  );
  await pg.query(`update statuses set deleted=true, origin=$2, updated_at=clock_timestamp() where id=$1`, [id, ctx.origin]);
}

export async function deleteSession(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(`update sessions set deleted=true, origin=$2, updated_at=clock_timestamp() where id=$1`, [id, ctx.origin]);
}

export async function restoreSession(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(`update sessions set deleted=false, origin=$2, updated_at=clock_timestamp() where id=$1`, [id, ctx.origin]);
}

export async function listEvents(ctx: Ctx, sessionId: string, limit?: number) {
  const pg = ctx.q;
  return (await pg.query(
    `select id, at, summary, kind, agent from session_events where session_id=$1 and not deleted
     order by at desc, id desc${limit ? " limit $2" : ""}`,
    limit ? [sessionId, limit] : [sessionId],
  )).rows;
}

// The page's own worklog: every entry of every session linked to it, merged newest
// first. `distinct` because a session linked to several lines joins once per link.
export async function listPageEvents(ctx: Ctx, pageId: string, limit = 100) {
  const pg = ctx.q;
  return (await pg.query(
    `select distinct e.id, e.at, e.summary, e.kind, e.agent, e.session_id,
            s.title as session_title, s.status as session_status
       from session_events e
       join session_links l on l.session_id = e.session_id and not l.deleted
       join sessions s on s.id = e.session_id and not s.deleted
      where l.page_id=$1 and not e.deleted
      order by e.at desc, e.id desc limit $2`,
    [pageId, limit],
  )).rows;
}

export async function countEvents(ctx: Ctx, sessionId: string): Promise<number> {
  const pg = ctx.q;
  const row = (await pg.query(
    `select count(*)::int as n from session_events where session_id=$1 and not deleted`,
    [sessionId],
  )).rows[0] as { n: number };
  return row.n;
}

export async function addEvent(ctx: Ctx, sessionId: string, summary: string, kind = "log", agent: string | null = null): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `insert into session_events (session_id, summary, kind, origin, agent) values ($1,$2,$3,$4,$5)`,
    [sessionId, summary, kind, ctx.origin, agent],
  );
  await pg.query(`update sessions set last_touched=clock_timestamp(), origin=$2, updated_at=clock_timestamp() where id=$1`, [sessionId, ctx.origin]);
}

// A track repeating the last one is a no-op (upsertSession already touched the card); manual logs always append.
export async function addTrackEvent(ctx: Ctx, sessionId: string, summary: string, agent: string | null = null): Promise<void> {
  const pg = ctx.q;
  const last = (await pg.query(
    `select summary, agent from session_events where session_id=$1 and kind='track' and not deleted
     order by at desc, id desc limit 1`,
    [sessionId],
  )).rows[0] as { summary: string | null; agent: string | null } | undefined;
  if (last && (last.summary ?? "").trim() === summary.trim() && (last.agent ?? null) === agent) return;
  await addEvent(ctx, sessionId, summary, "track", agent);
}

export async function linksForSession(ctx: Ctx, sessionId: string) {
  const pg = ctx.q;
  return (await pg.query(
    `select l.id, l.page_id, l.block_id, l.anchor, p.title as page_title
       from session_links l join pages p on p.id = l.page_id and not p.deleted
      where l.session_id=$1 and not l.deleted order by l.updated_at`,
    [sessionId],
  )).rows;
}

export async function addSessionLink(
  ctx: Ctx,
  sessionId: string,
  pageId: string,
  blockId: string | null,
  anchor: string,
): Promise<string> {
  const pg = ctx.q;
  const row = (await pg.query(
    `insert into session_links (session_id, page_id, block_id, anchor, origin)
     values ($1,$2,$3,$4,$5) returning id`,
    [sessionId, pageId, blockId, anchor, ctx.origin],
  )).rows[0] as { id: string };
  return row.id;
}

// One session as the drawer shows it: the ids it joins (project, story) resolved to
// names, plus the worklog and backlinks /api/board leaves out. Null when unknown/deleted.
export async function getSession(ctx: Ctx, id: string, eventLimit = 20) {
  const pg = ctx.q;
  const s = (await pg.query(`select * from sessions where id=$1 and not deleted`, [id]))
    .rows[0] as Record<string, unknown> | undefined;
  if (!s) return null;
  const one = async (pageId: unknown, kind?: string) => {
    if (typeof pageId !== "string") return null;
    return (await pg.query(
      `select id, title, kind from pages where id=$1 and not deleted${kind ? ` and kind='${kind}'` : ""}`,
      [pageId],
    )).rows[0] ?? null;
  };
  const project = await one(s.client_id, "project") as { id: string; title: string } | null;
  // the story slot accepts any page, not just kind='story' — matches the drawer's picker
  const story = await one(s.page_id) as { id: string; title: string; kind: string } | null;
  // specs are read-only here, rendered from the spec page; write via ensureSpecsPage
  const specPage = typeof s.specs_page_id === "string"
    ? (await pg.query(`select content from pages where id=$1 and not deleted`, [s.specs_page_id]))
      .rows[0] as { content: unknown[] } | undefined
    : undefined;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    agent: s.agent,
    repo_path: s.repo_path,
    branch: s.branch,
    pr_url: s.pr_url,
    next_step: s.next_step,
    specs_page_id: s.specs_page_id ?? null,
    tags: s.tags,
    specs: specPage ? pageBlocksToMarkdown(specPage.content ?? []) : null,
    project: project && { id: project.id, name: project.title },
    story,
    links: await linksForSession(ctx, id),
    activity: await listEvents(ctx, id, eventLimit),
    activity_total: await countEvents(ctx, id),
    last_touched: s.last_touched,
    updated_at: s.updated_at,
  };
}

export async function deleteSessionLink(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update session_links set deleted=true, updated_at=clock_timestamp(), origin=$2 where id=$1`,
    [id, ctx.origin],
  );
}

export async function updateStory(ctx: Ctx, o: { id: string; title?: string; brief?: string; status?: string }): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update pages set
       title = coalesce($2, title),
       brief = coalesce($3, brief),
       status = coalesce($4, status),
       origin = $5, updated_at = clock_timestamp()
     where id = $1`,
    [o.id, o.title ?? null, o.brief ?? null, o.status ?? null, ctx.origin],
  );
}

export async function listReports(ctx: Ctx) {
  const pg = ctx.q;
  return (await pg.query(
    `select id, title, client_id, page_id, created_at from reports where not deleted order by created_at desc`,
  )).rows;
}

export async function getReport(ctx: Ctx, id: string) {
  const pg = ctx.q;
  return (await pg.query(`select * from reports where id=$1 and not deleted`, [id])).rows[0] ?? null;
}

export async function createReport(ctx: Ctx, r: { title: string; html: string; client?: string; story?: string }) {
  const pg = ctx.q;
  const clientId = r.client ? await resolveClient(ctx, r.client) : null;
  const pageId = r.story ? await resolveStory(ctx, r.story, clientId) : null;
  const row = (await pg.query(
    `insert into reports (title, html, client_id, page_id, origin) values ($1,$2,$3,$4,$5) returning id`,
    [r.title, r.html, clientId, pageId, ctx.origin],
  )).rows[0] as { id: string };
  return row.id;
}

// unpublish — soft delete, like every other synced row
export async function deleteReport(ctx: Ctx, id: string): Promise<void> {
  const pg = ctx.q;
  await pg.query(
    `update reports set deleted=true, origin=$2, updated_at=clock_timestamp() where id=$1`,
    [id, ctx.origin],
  );
}

