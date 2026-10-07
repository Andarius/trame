// The /api routes both the laptop app and the hub serve: board, sessions, stories,
// statuses, tags, pages, comments. Null = not a core route.
import { agentIdentity, resolveCommentBlock } from "./agent-comments.ts";
import { SPECS_WHEN } from "./agent-texts.ts";
import type { Ctx } from "./ctx.ts";
import { identityOf } from "./identity.ts";
import { AGENT_ID_RE, listPresence, touchPresence } from "./presence.ts";
import { listDue } from "./due.ts";
import { stripMarks } from "./todo-marks.ts";
import { AgentPresenceError, journalPresence, listLiveAgents, touchAgentPresence } from "./agent-presence.ts";
import {
  createProperty,
  createRow,
  createUdb,
  deleteProperty,
  deleteRow,
  deleteUdb,
  getUdb,
  listIcons,
  listUdbs,
  patchRow,
  setLink,
  updateProperty,
  updateUdb,
} from "./udb.ts";
import {
  attachUdbToPage,
  createComment,
  createPage,
  deleteComment,
  deletePage,
  getPage,
  listCommentInbox,
  listComments,
  listPages,
  movePage,
  setCommentAgentStatus,
  updateComment,
  updatePage,
} from "./pages.ts";
import {
  addEvent,
  addSessionLink,
  ensureSessionLink,
  addTrackEvent,
  createStatus,
  createStory,
  deleteSession,
  deleteSessionLink,
  deleteStatus,
  deleteTag,
  ensureSpecsPage,
  ensureTag,
  findSimilarStories,
  getBoard,
  getSession,
  linksForSession,
  listEvents,
  listPageEvents,
  listTags,
  moveStatus,
  restoreSession,
  searchAll,
  sessionFromPage,
  storyFromPage,
  SessionTagsError,
  setSessionStatus,
  updateStatus,
  updateStory,
  updateTag,
  upsertSession,
} from "./sessions.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a model id as agents report it (claude-opus-5-5, gpt-5.5-codex, glm-4.6)
const usageOf = (b: Record<string, unknown>) => ({
  model: typeof b.model === "string" && b.model.trim() ? b.model.trim().slice(0, 80) : null,
  tokens: typeof b.tokens === "number" && Number.isFinite(b.tokens) && b.tokens >= 0 ? Math.round(b.tokens) : null,
  cost_usd: typeof b.cost_usd === "number" && Number.isFinite(b.cost_usd) && b.cost_usd >= 0 ? b.cost_usd : null,
  agent_name: typeof b.agent_name === "string" && b.agent_name.trim() ? b.agent_name.trim().slice(0, 60) : null,
});
// page block ids: editor genId (8 chars) or uuids
const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleCoreApi(
  ctx: Ctx,
  req: Request,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;
  if (pathname === "/api/board") {
    return json(
      await getBoard(ctx, { deleted: url.searchParams.get("deleted") === "1" }),
    );
  }
  // Quick-find (Ctrl+P): search sessions/pages/databases; empty q = recently touched.
  if (pathname === "/api/search") {
    return json(await searchAll(ctx, url.searchParams.get("q") ?? ""));
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await req.json();
    // an agent picking up an existing card adopts it: no story matching, and its own
    // session id lands in claude_id so presence and Resume follow the new agent
    if (body.card !== undefined) {
      const card = String(body.card).toLowerCase();
      if (!UUID_RE.test(card)) return json({ error: "card must be a session id" }, 400);
      const known = (await ctx.q.query(`select 1 from sessions where id=$1 and not deleted`, [card])).rows.length;
      if (!known) return json({ error: `no card ${card}` }, 404);
      body.id = card;
      delete body.card;
    }
    let id: string;
    const storyOut: { story_note?: string } = {};
    try {
      id = await upsertSession(ctx, body, storyOut);
    } catch (e) {
      if (e instanceof SessionTagsError) return json({ error: e.message }, 400);
      throw e;
    }
    // A summary from track/MCP is a worklog entry, not just a field.
    if (
      typeof body.summary === "string" && body.summary.trim() && !body.no_event
    ) {
      await addTrackEvent(
        ctx,
        id,
        body.summary,
        typeof body.agent === "string" ? body.agent : null,
        usageOf(body),
      );
    }
    // Planned-work backlinks (plan/TODO pages) ride the same POST; dedupe by
    // page+block+anchor so repeated tracking doesn't pile up chips, while two items
    // of the same list block stay distinct.
    if (Array.isArray(body.links) && body.links.length) {
      const key = (
        l: {
          page_id: string;
          block_id?: string | null;
          anchor?: string | null;
        },
      ) => `${l.page_id}:${l.block_id ?? ""}:${l.anchor ?? ""}`;
      const have = new Set(
        (await linksForSession(ctx, id) as {
          page_id: string;
          block_id: string | null;
          anchor: string;
        }[])
          .map(key),
      );
      for (const l of body.links) {
        if (typeof l?.page_id !== "string") continue;
        // an agent knows the task's text, not its block id: resolve the anchor to a
        // block the way page comments do (a todo is a block, so this covers todos)
        let blockId: string | null = l.block_id ?? null;
        if (!blockId && typeof l.anchor === "string" && l.anchor.trim()) {
          const page = await getPage(ctx, l.page_id) as
            | { content?: unknown }
            | null;
          try {
            blockId =
              resolveCommentBlock(page?.content, { block_text: l.anchor }).id;
          } catch {
            blockId = null; // no unique match — fall back to a page-level link
          }
        }
        const want = {
          page_id: l.page_id,
          block_id: blockId,
          anchor: l.anchor ?? "",
        };
        if (have.has(key(want))) continue;
        have.add(key(want));
        await addSessionLink(ctx, id, l.page_id, blockId, want.anchor);
      }
    }
    // Nudge every write path (skill, writer, MCP, raw curl) toward a specs page.
    const pg = ctx.q;
    const s =
      (await pg.query(`select specs_page_id from sessions where id=$1`, [id]))
        .rows[0] as { specs_page_id: string | null } | undefined;
    const spec = s?.specs_page_id
      ? (await pg.query(
        `select 1 from pages where id=$1 and not deleted and content::text <> '[]'`,
        [s.specs_page_id],
      )).rows[0]
      : undefined;
    // closing a card with unticked spec todos is usually a forgotten tick
    const open = spec
      ? (await pg.query(
        `select b->>'text' as text from sessions s join pages p on p.id = s.specs_page_id,
                jsonb_array_elements(case when jsonb_typeof(p.content) = 'array' then p.content else '[]' end) b
          where s.id=$1 and s.status in (select key from statuses where terminal and not deleted)
            and b->>'type' = 'todo' and coalesce((b->>'done')::boolean, false) = false`,
        [id],
      )).rows as { text: string }[]
      : [];
    const note = !spec
      ? (`card has no specs page. ${
        SPECS_WHEN.replaceAll("\n", " ")
      } Write it with the page writer/trame_update_page using {"session_id": "${id}"}`)
      : open.length
      ? `card closed with ${open.length} open todo(s) on its specs page: ${
        open.map((t) => `'${stripMarks(t.text).trim()}'`).join(", ")
      } — tick the done ones, or move the rest to a follow-up card`
      : undefined;
    return json({
      id,
      specs_page_id: s?.specs_page_id ?? null,
      ...(note ? { note } : {}),
      ...storyOut,
    });
  }
  const spm = pathname.match(/^\/api\/sessions\/([^/]+)\/specs-page$/);
  if (spm && req.method === "POST") {
    return json({ page_id: await ensureSpecsPage(ctx, spm[1]) });
  }
  const lm = pathname.match(/^\/api\/sessions\/([^/]+)\/links$/);
  if (lm && req.method === "POST") {
    const b = await req.json();
    return json({
      id: await addSessionLink(
        ctx,
        lm[1],
        b.page_id,
        b.block_id ?? null,
        b.anchor ?? "",
      ),
    });
  }
  if (lm) return json(await linksForSession(ctx, lm[1]));
  const ldm = pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
  if (ldm && req.method === "POST") {
    await deleteSessionLink(ctx, ldm[1]);
    return json({ ok: true });
  }
  // a harness pushes what its agent is doing (ephemeral, see agent-presence.ts)
  const apm = pathname.match(/^\/api\/sessions\/([^/]+)\/presence$/);
  if (apm && req.method === "POST") {
    const raw = apm[1].toLowerCase(); // db ids are lowercase; the GET joins on them
    if (!UUID_RE.test(raw)) return json({ error: "invalid session id" }, 400);
    // a card id, or the harness's own session uuid (Claude/Codex, stored as claude_id)
    const card = (await ctx.q.query(
      `select id from sessions where (id=$1 or claude_id=$1) and not deleted
        order by (id=$1) desc, last_touched desc limit 1`,
      [raw],
    )).rows[0] as { id: string } | undefined;
    if (!card) return json({ error: "no card for that session" }, 404);
    const sid = card.id;
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      return json({ error: "JSON object expected" }, 400);
    }
    // the todo being worked on: must be a real block of a real page
    if (b.page_id !== undefined || b.block_id !== undefined) {
      if (!UUID_RE.test(String(b.page_id)) || !BLOCK_ID_RE.test(String(b.block_id))) {
        return json({ error: "page_id (uuid) and block_id go together" }, 400);
      }
      b.page_id = String(b.page_id).toLowerCase();
      const page = await getPage(ctx, b.page_id) as { content?: { id?: string }[] } | null;
      if (!page?.content?.some((x) => x.id === b.block_id)) {
        return json({ error: "no such block on that page" }, 400);
      }
    }
    let p;
    try {
      p = touchAgentPresence(sid, b);
    } catch (e) {
      if (e instanceof AgentPresenceError) return json({ error: e.message }, 400);
      throw e;
    }
    await journalPresence(ctx, sid, p, b.ended === true);
    // link the session to that todo once, so the card shows it too
    if (b.block_id) {
      await ensureSessionLink(ctx, sid, b.page_id, b.block_id, typeof b.anchor === "string" ? b.anchor : "");
    }
    return json(p);
  }
  const em = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (em && req.method === "POST") {
    const b = await req.json();
    // optional attribution: which agent/model wrote this entry (null = a human)
    const agent = typeof b.agent === "string" && AGENT_ID_RE.test(b.agent) ? b.agent : null;
    // presence: a session joining or leaving the card (rendered as a pill, not a log line)
    const kind = b.kind === "presence" ? "presence" : "log";
    await addEvent(ctx, em[1], b.summary ?? "", kind, agent, usageOf(b));
    return json({ ok: true });
  }
  if (em) return json(await listEvents(ctx, em[1]));
  // one resolved session card (project/story by name, links, worklog) — see getSession
  const sm = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sm && req.method === "GET") {
    const s = await getSession(
      ctx,
      sm[1],
      Number(url.searchParams.get("events")) || 20,
    );
    return s ? json(s) : json({ error: "not found" }, 404);
  }
  const dm = pathname.match(/^\/api\/sessions\/([^/]+)\/delete$/);
  if (dm && req.method === "POST") {
    await deleteSession(ctx, dm[1]);
    return json({ ok: true });
  }
  const rm = pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (rm && req.method === "POST") {
    await restoreSession(ctx, rm[1]);
    return json({ ok: true });
  }
  if (pathname === "/api/stories/similar") {
    const p = url.searchParams;
    return json(
      await findSimilarStories(ctx, p.get("q") ?? "", {
        client: p.get("client") ?? undefined,
        repo_path: p.get("repo_path") ?? undefined,
      }),
    );
  }
  if (pathname === "/api/stories" && req.method === "POST") {
    return json({ id: await createStory(ctx, await req.json()) });
  }
  const om = pathname.match(/^\/api\/stories\/([^/]+)$/);
  if (om && req.method === "POST") {
    await updateStory(ctx, { id: om[1], ...(await req.json()) });
    return json({ ok: true });
  }
  const m = pathname.match(/^\/api\/sessions\/([^/]+)\/status$/);
  if (m && req.method === "POST") {
    await setSessionStatus(ctx, m[1], (await req.json()).status);
    return json({ ok: true });
  }

  // statuses — the kanban columns (add/rename/recolor/reorder/delete)
  if (pathname === "/api/statuses" && req.method === "POST") {
    const b = await req.json();
    return json({
      id: await createStatus(ctx, {
        label: b.label,
        color: b.color,
        terminal: b.terminal,
      }),
    });
  }
  const stm = pathname.match(/^\/api\/statuses\/([^/]+)(\/delete|\/move)?$/);
  if (stm && req.method === "POST") {
    try {
      if (stm[2] === "/delete") await deleteStatus(ctx, stm[1]);
      else if (stm[2] === "/move") {
        await moveStatus(ctx, stm[1], (await req.json()).dir === -1 ? -1 : 1);
      } else await updateStatus(ctx, stm[1], await req.json());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    return json({ ok: true });
  }

  // tags — free labels on pages (create is find-or-create, cf. ensureTag)
  if (pathname === "/api/tags") {
    if (req.method === "POST") {
      const b = await req.json();
      if (typeof b.label !== "string" || !b.label.trim()) {
        return json({ error: "label required" }, 400);
      }
      return json(
        await ensureTag(ctx, { label: b.label.trim(), color: b.color }),
      );
    }
    return json(await listTags(ctx));
  }
  const tgm = pathname.match(/^\/api\/tags\/([^/]+)(\/delete)?$/);
  if (tgm && req.method === "POST") {
    try {
      if (tgm[2] === "/delete") await deleteTag(ctx, tgm[1]);
      else await updateTag(ctx, tgm[1], await req.json());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    return json({ ok: true });
  }

  // inline page comments (block-level notes)
  if (pathname === "/api/comments" && req.method === "POST") {
    return json({ id: await createComment(ctx, await req.json()) });
  }
  if (pathname === "/api/comments/inbox") {
    const stale = Number(url.searchParams.get("stale") ?? "600");
    const pages = (url.searchParams.get("page") ?? "").split(",")
      .map((s) => s.trim()).filter((s) => UUID_RE.test(s));
    return json(
      await listCommentInbox(ctx, Number.isFinite(stale) ? stale : 600, {
        pages: pages.length ? pages : undefined,
        // mode=all: any pending human comment, not just replies on agent threads
        all: url.searchParams.get("mode") === "all",
      }),
    );
  }
  if (pathname === "/api/comments") {
    const pageId = url.searchParams.get("page");
    return json(pageId ? await listComments(ctx, pageId) : []);
  }
  const cmtStatus = pathname.match(/^\/api\/comments\/([^/]+)\/agent-status$/);
  if (cmtStatus && req.method === "POST") {
    const body = await req.json();
    // enum-indexed badge in the UI crashes on an unknown status — reject up front
    const STATUSES = ["seen", "answering", "failed", "answered", "clear"];
    if (!STATUSES.includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    await setCommentAgentStatus(ctx, cmtStatus[1], body);
    return json({ ok: true });
  }
  const cmt = pathname.match(/^\/api\/comments\/([^/]+)(\/delete)?$/);
  if (cmt && req.method === "POST") {
    if (cmt[2]) await deleteComment(ctx, cmt[1]);
    else await updateComment(ctx, cmt[1], await req.json());
    return json({ ok: true });
  }

  if (pathname === "/api/pages" && req.method === "POST") {
    try {
      return json({ id: await createPage(ctx, await req.json()) });
    } catch (e) {
      // Same contract as the update route below: a rejected field is the
      // caller's problem, not a 500.
      return json({ error: (e as Error).message }, 400);
    }
  }
  if (pathname === "/api/pages") return json(await listPages(ctx));
  const pgev = pathname.match(/^\/api\/pages\/([^/]+)\/events$/);
  if (pgev && req.method === "GET") {
    return json(await listPageEvents(ctx, pgev[1]));
  }
  // a page becomes a user story under its project (explicit; see storyFromPage)
  const pgsto = pathname.match(/^\/api\/pages\/([^/]+)\/story$/);
  if (pgsto && req.method === "POST") {
    try {
      return json(await storyFromPage(ctx, pgsto[1]));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  // a page becomes a card whose specs are that page (idempotent: same page, same card)
  const pgses = pathname.match(/^\/api\/pages\/([^/]+)\/session$/);
  if (pgses && req.method === "POST") {
    try {
      return json(await sessionFromPage(ctx, pgses[1]));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  const pgm = pathname.match(/^\/api\/pages\/([^/]+)(\/delete|\/move)?$/);
  if (pgm && req.method === "POST") {
    try {
      if (pgm[2] === "/delete") await deletePage(ctx, pgm[1]);
      else if (pgm[2] === "/move") {
        await movePage(ctx, pgm[1], await req.json());
      } else await updatePage(ctx, pgm[1], await req.json());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    return json({ ok: true });
  }
  if (pgm && !pgm[2]) {
    const page = await getPage(ctx, pgm[1]);
    return page ? json(page) : json({ error: "not found" }, 404);
  }
  // ephemeral presence (device-local, not synced): who's on a page + active watchers
  if (pathname === "/api/presence" && req.method === "POST") {
    const b = await req.json();
    if (typeof b.watcher === "string" && AGENT_ID_RE.test(b.watcher)) {
      const a = agentIdentity(b.watcher);
      // no pages → global watcher ("*"); a --page-scoped watcher registers one
      // entry per page so its badge only shows there
      const pages: string[] = Array.isArray(b.pages)
        ? b.pages.filter((p: unknown) =>
          typeof p === "string" && UUID_RE.test(p)
        )
        : [];
      for (const pid of pages.length ? pages : ["*"]) {
        touchPresence({
          id: pid === "*"
            ? `watcher:${b.watcher}`
            : `watcher:${b.watcher}:${pid}`,
          kind: "watcher",
          name: a.name,
          avatar: a.avatar,
          page_id: pid,
        });
      }
    } else {
      const me = await identityOf(ctx);
      const page = String(b.page_id ?? "");
      touchPresence({
        // key by user AND page so the same user in two tabs on different pages
        // gets one entry each instead of flapping over a single user-keyed row
        id: `${me.userId ?? `dev:${ctx.origin}`}:${page}`,
        kind: "viewer",
        name: me.name,
        avatar: me.avatar,
        page_id: page,
      });
    }
    return json({ ok: true });
  }
  if (pathname === "/api/agent-presence") return json(await listLiveAgents(ctx));
  if (pathname === "/api/due") return json(await listDue(ctx));
  if (pathname === "/api/presence") {
    return json(listPresence(url.searchParams.get("page") ?? ""));
  }
  // user-defined databases — specific routes before the /api/udb/:id catch-all
  if (pathname === "/api/udb" && req.method === "POST") {
    return json({
      id: await createUdb(ctx, (await req.json()).name ?? "Untitled"),
    });
  }
  if (pathname === "/api/udb") return json(await listUdbs(ctx));
  if (pathname === "/api/udb/icons") return json(await listIcons(ctx));
  if (pathname === "/api/udb/links" && req.method === "POST") {
    const b = await req.json();
    await setLink(ctx, b.prop_id, b.from_row, b.to_row, Boolean(b.remove));
    return json({ ok: true });
  }
  const upd = pathname.match(/^\/api\/udb\/props\/([^/]+)(\/delete)?$/);
  if (upd && req.method === "POST") {
    if (upd[2]) await deleteProperty(ctx, upd[1]);
    else {
      try {
        await updateProperty(ctx, upd[1], await req.json());
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    return json({ ok: true });
  }
  const urw = pathname.match(/^\/api\/udb\/rows\/([^/]+)(\/delete)?$/);
  if (urw && req.method === "POST") {
    if (urw[2]) await deleteRow(ctx, urw[1]);
    else {
      const b = await req.json();
      await patchRow(
        ctx,
        urw[1],
        b.vals ?? {},
        "icon" in b ? b.icon : undefined,
      );
    }
    return json({ ok: true });
  }
  const usub = pathname.match(/^\/api\/udb\/([^/]+)\/(props|rows|delete)$/);
  if (usub && req.method === "POST") {
    if (usub[2] === "delete") {
      await deleteUdb(ctx, usub[1]);
      return json({ ok: true });
    }
    if (usub[2] === "props") {
      try {
        return json({
          id: await createProperty(ctx, usub[1], await req.json()),
        });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    const rb = await req.json();
    return json({
      id: await createRow(ctx, usub[1], rb.vals, rb.icon ?? null),
    });
  }
  const udm = pathname.match(/^\/api\/udb\/([^/]+)$/);
  if (udm && req.method === "POST") {
    const b = await req.json();
    if ("page_id" in b) await attachUdbToPage(ctx, udm[1], b.page_id);
    await updateUdb(ctx, udm[1], b);
    return json({ ok: true });
  }
  if (udm) {
    const data = await getUdb(ctx, udm[1]);
    return data ? json(data) : json({ error: "not found" }, 404);
  }
  return null;
}
