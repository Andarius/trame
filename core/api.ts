// The /api routes both the laptop app and the hub serve: board, sessions, stories,
// statuses, tags, pages, comments. Null = not a core route.
import { resolveCommentBlock } from "./agent-comments.ts";
import { SPECS_WHEN } from "./agent-texts.ts";
import type { Ctx } from "./ctx.ts";
import {
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
  SessionTagsError,
  setSessionStatus,
  updateStatus,
  updateStory,
  updateTag,
  upsertSession,
} from "./sessions.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const note = spec
      ? undefined
      : (`card has no specs page. ${
        SPECS_WHEN.replaceAll("\n", " ")
      } Write it with the page writer/trame_update_page using {"session_id": "${id}"}`);
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
  const em = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (em && req.method === "POST") {
    await addEvent(ctx, em[1], (await req.json()).summary ?? "");
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
  return null;
}
