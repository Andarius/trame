// Trame MCP server (stdio). Thin wrapper over the running app's HTTP API, so any
// Claude session can read the board, track sessions, and move cards. The app writes
// its bound port to PORT_FILE on startup (random port in desktop mode).
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.12/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.12/server/stdio.js";
import { z } from "npm:zod@^3.24";
import { PORT_FILE } from "../app/config.ts";
import { HTML_BLOCK_MAX_BYTES } from "../protocol/html.ts";
import { PAGE_DIALECT, SPECS_WHEN, TODO_SYNTAX } from "../track/help.ts";
// the page/comment tools delegate to the tramecli writers, so both surfaces share
// one implementation (markdown conversion, block merge, resolution, attribution)
import { writePage } from "../track/page.ts";
import { addComment } from "../track/comment.ts";
import { parseSessionRef } from "./session_url.ts";

async function appPort(): Promise<number> {
  try {
    return JSON.parse(await Deno.readTextFile(PORT_FILE)).port;
  } catch {
    throw new Error(
      "Trame app is not running (no port file). Start it with `just dev` or `just serve`.",
    );
  }
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const port = await appPort();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init).catch(() => {
    throw new Error(
      "Trame app is not reachable (stale port file?). Start it with `just dev` or `just serve`.",
    );
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const post = (path: string, body: unknown) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

async function resolvePageId(
  args: { page_id?: string; page_title?: string },
): Promise<string> {
  if (Boolean(args.page_id) === Boolean(args.page_title)) {
    throw new Error("use exactly one of page_id or page_title");
  }
  if (args.page_id) return args.page_id;
  const pages = await api("/api/pages") as { id: string; title: string }[];
  const matches = pages.filter((p) => p.title === args.page_title);
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `page_title "${args.page_title}" is ambiguous; use page_id`
        : `page "${args.page_title}" was not found`,
    );
  }
  return matches[0].id;
}

const server = new McpServer({ name: "trame", version: "0.1.0" });

// One-call, self-describing map of what an agent can do with Trame — so discovery
// doesn't depend on happening to read the right tool description. Keep it current
// when tools or their semantics change; the Markdown dialect comes from
// track/help.ts (shared with tramecli --help).
const CAPABILITIES = `# Trame — capabilities for agents

Trame is a local-first tracker (sessions, pages, databases) that syncs to a shared hub.
As an agent you can:

## Review comments (conversational)
- Leave inline comments on a page block with **trame_add_comment** (page by id/title,
  block by id or a unique text quote).
- **Attribution**: set \`agent\` to the id of the model ACTUALLY writing (codex, claude,
  glm, gemini, …) — not the harness seat. codex/claude get a branded avatar; any other
  id gets a generated one. Never post as a human.
- **\`meta.model\` is required** — the exact model id you run as; it shows as a footer.
  Running as claude or codex, \`in\`/\`out\`/\`ms\` are required too — both harnesses
  report their own usage, so read it there. Other agents omit what they can't measure;
  never guess a number (a footer must be real).
- **The watcher loop**: a human may reply to your comment. If the human runs \`tramecli answer\`,
  YOUR agent is invoked to answer that reply — so a thread is a back-and-forth, not a
  one-shot. Your answer posts as the next comment; the watcher fills its meta for you.

## Pages & reports
- **trame_create_page** — create a page from Markdown (not a session card). It files
  itself under the project owning \`repo_path\` (pass your working directory); pass
  parent_id only to nest it elsewhere.
- **trame_update_page** — replace a page's content from Markdown IN PLACE; unchanged
  blocks keep their ids so inline comments stay anchored. Reply to comments before updating.
- **trame_move_page** — reparent/reorder an existing page (fix a wrong parent, nest under another page).
- **trame_html** — embed an interactive HTML doc on a page (sandboxed iframe, scripts run).
  The doc calls \`window.trame.send(data)\` to persist structured results on the block;
  **trame_html_data** reads them back. Use this to ASK the user something visual
  (option pickers, forms) — they click in Trame, you read the answer. Prefer it over
  trame_report when you want an answer back.
- **trame_report** — publish a self-contained HTML report to the Explore view.

## Page Markdown dialect
${PAGE_DIALECT}

## Todo lines
${TODO_SYNTAX}

A session's specs are a page too (a subpage of the card's story) — write them with
\`trame_update_page\` passing \`{session_id}\`. ${SPECS_WHEN}

## Sessions (the board)
- **trame_session** — read ONE card the way the user sees it: project and story by name,
  branch, PR, next step, specs, backlinks and the activity worklog. Takes a session id or
  a Trame URL the user pasted — when someone gives you a link, read it with this rather
  than guessing what is on it. \`trame_board\` returns raw ids and no worklog.
- **trame_track** — create/update a work session (upsert by repo_path+branch).
- **trame_set_status** — move a card between columns.
- **trame_new_objective** — create the story/epic sessions ladder up to.

## Read / sync
- **trame_board** — read sessions, stories, projects. **trame_reports** — list reports.
- **trame_sync** — push/pull with the hub now.

The app must be running (it writes its port for these tools). All writes ride the normal
LWW sync to the hub.`;

server.tool(
  "trame_capabilities",
  "What an agent can do with Trame — a one-call overview of the comment/watcher loop, model attribution, pages, sessions, and reports. Call this first to discover Trame's features instead of guessing from individual tool descriptions.",
  {},
  () => ({ content: [{ type: "text" as const, text: CAPABILITIES }] }),
);

server.tool(
  "trame_board",
  "Read the Trame board: all sessions with status/client/objective/branch/next_step, plus stories and projects.",
  {},
  async () => text(await api("/api/board")),
);

server.tool(
  "trame_session",
  "Read ONE work session — the card the user sees in the app: project and story by name (not raw ids), status, repo path, branch, PR, next step, specs (rendered read-only from the spec page; write via trame_update_page with session_id), backlink chips and the activity worklog. Accepts a session id or a Trame URL the user pasted (`…/?session=<id>`); a `?page=<id>` link with no session returns that page's sessions instead. Use this instead of scanning trame_board when you have a specific card or link.",
  {
    session: z.string().describe(
      "Session id, or a pasted Trame URL (…/?session=<id>&full=1 or …/?page=<id>)",
    ),
    events: z.number().optional().describe(
      "Worklog entries to return, newest first (default 20)",
    ),
  },
  async ({ session, events }: { session: string; events?: number }) => {
    const ref = parseSessionRef(session);
    if (!ref) {
      return text({
        error:
          `not a session id or Trame URL: ${session} — pass a uuid, or a link containing ?session=<uuid> or ?page=<uuid>`,
      });
    }
    if (ref.kind === "page") {
      // the link pointed at a page, not a card — hand back the cards anchored to it
      const page = await api(`/api/pages/${ref.id}`) as Record<string, unknown>;
      return text({
        note:
          "URL had no ?session= — returning the page and the sessions anchored to it",
        page: { id: page.id, title: page.title, kind: page.kind },
        sessions: page.sessions ?? [],
      });
    }
    const q = events ? `?events=${events}` : "";
    const card = await api(`/api/sessions/${ref.id}${q}`) as Record<
      string,
      unknown
    >;
    // hand back a link the user can click, even when called with a bare id
    return text({
      ...card,
      url: `http://127.0.0.1:${await appPort()}/?session=${ref.id}&full=1`,
    });
  },
);

server.tool(
  "trame_track",
  `Create or update a session (upserts by repo_path+branch among open sessions). Client and objective are names — they are resolved or created. Specs live on the session's spec page: write them with trame_update_page {session_id} after tracking (the response returns specs_page_id). ${SPECS_WHEN.replaceAll("\n", " ")}`,
  {
    title: z.string(),
    status: z.enum(["active", "paused", "blocked", "done"]).optional(),
    client: z.string().optional(),
    objective: z.string().optional(),
    repo_path: z.string().optional(),
    branch: z.string().optional(),
    next_step: z.string().optional(),
    links: z.array(z.object({
      page_id: z.string(),
      block_id: z.string().optional(),
      anchor: z.string().optional(),
    })).optional()
      .describe(
        "Backlink chips shown above the specs (e.g. the plan page and the TODO page a planned-work card came from); deduped by page+block",
      ),
    pr_url: z.string().optional(),
    summary: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    text(await post("/api/sessions", args)),
);

server.tool(
  "trame_set_status",
  "Move a session card to another column.",
  { id: z.string(), status: z.enum(["active", "paused", "blocked", "done"]) },
  async ({ id, status }: { id: string; status: string }) =>
    text(await post(`/api/sessions/${id}/status`, { status })),
);

server.tool(
  "trame_new_objective",
  "Create an objective (the story/epic sessions ladder up to). Include the story: what are we trying to achieve, and 'done when'.",
  {
    title: z.string(),
    story: z.string().optional(),
    client: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    text(await post("/api/objectives", args)),
);

server.tool(
  "trame_create_page",
  "Create a new Trame page/document from Markdown. Use this instead of putting a document into a session card. The page is filed under the project owning repo_path (pass the working directory; the server falls back to its own) — pass parent_id only to nest it somewhere else, e.g. under another page (trame_board lists projects and pages). The Markdown dialect (tab/fold section headings, todos, pills, mermaid, PR chips) is listed by trame_capabilities.",
  {
    title: z.string(),
    markdown: z.string().optional(),
    parent_id: z.string().optional(),
    repo_path: z.string().optional(),
    icon: z.string().optional(),
  },
  async (
    { title, markdown, parent_id, repo_path, icon }: {
      title: string;
      markdown?: string;
      parent_id?: string;
      repo_path?: string;
      icon?: string;
    },
  ) => {
    const res = await writePage(
      { title, markdown, ...(parent_id ? { parent_id } : {}), repo_path, icon },
      `http://127.0.0.1:${await appPort()}`,
    );
    if (res.action !== "created") throw new Error("expected a page creation");
    return text({ id: res.id, filed_under: res.parent });
  },
);

server.tool(
  "trame_update_page",
  "Replace a Trame page's content from Markdown IN PLACE (full new content, not a diff). Blocks whose text is unchanged keep their ids, so inline comments stay attached; comments on changed blocks detach to their quoted snapshot. Use for revising a page you authored (e.g. a plan revision) — reply to the comments you are addressing BEFORE updating. Structural blocks (html/database/subpage) are preserved. Optional title renames the page. Pass session_id (instead of page_id/page_title) to write a session's SPECS: the spec page is found or created, then updated the same way. See trame_capabilities for the page Markdown dialect.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    session_id: z.string().optional(),
    markdown: z.string(),
    title: z.string().optional(),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      session_id?: string;
      markdown: string;
      title?: string;
    },
  ) => {
    if (!args.session_id && !args.page_id && !args.page_title) {
      throw new Error("use page_id, page_title, or session_id");
    }
    const res = await writePage(args, `http://127.0.0.1:${await appPort()}`);
    return text({ page_id: res.id });
  },
);

server.tool(
  "trame_move_page",
  "Move/reparent a page (or reorder it among siblings). Identify the page by id or exact title. Set parent_id to a page id to nest it, or null to move it to the top level (omit parent_id to keep its current parent and just reorder). Optionally drop it right before/after a sibling with before_id/after_id (sibling ids, not titles). Rejects cycles (can't move a page under itself or a descendant).",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    before_id: z.string().optional(),
    after_id: z.string().optional(),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      parent_id?: string | null;
      before_id?: string;
      after_id?: string;
    },
  ) => {
    if (args.before_id && args.after_id) {
      throw new Error("use before_id or after_id, not both");
    }
    const pageId = await resolvePageId(args);
    await post(`/api/pages/${pageId}/move`, {
      parent_id: args.parent_id,
      before_id: args.before_id,
      after_id: args.after_id,
    });
    return text({ ok: true });
  },
);

server.tool(
  "trame_add_comment",
  "Add an inline agent review comment to a Trame page block. Identify the page by id or exact title and the block by id or a unique text quote. `agent` is the id of the model actually writing (e.g. codex, claude, glm, gemini) — attribute the real model, not the harness seat; codex/claude get a branded avatar, any other id gets a generated one. `meta.model` is required and records the exact model id you are running as (e.g. claude-opus-5, gpt-5.6-sol) — it renders as a footer under the comment. `in`/`out`/`ms` (input tokens, output tokens, elapsed milliseconds) are required when running as claude or codex — both harnesses report their own usage, so read it there rather than guessing; other agents may omit stats they cannot measure.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    block_id: z.string().optional(),
    block_text: z.string().optional(),
    body: z.string(),
    agent: z.string(),
    meta: z.object({
      model: z.string(),
      in: z.number().optional(),
      out: z.number().optional(),
      ms: z.number().optional(),
    }),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      block_id?: string;
      block_text?: string;
      body: string;
      agent: string;
      meta: { model: string; in?: number; out?: number; ms?: number };
    },
  ) => {
    const res = await addComment(args, `http://127.0.0.1:${await appPort()}`);
    return text({ id: res.id });
  },
);

server.tool(
  "trame_html",
  "Embed a self-contained interactive HTML document on a Trame page as a sandboxed block (scripts run, no network/origin). The doc can persist structured results — picks, form answers — by calling window.trame.send(data); read them back with trame_html_data. On reload the block replays saved data to the doc: listen for the 'trame:init' event and read window.trame.data to restore UI state. Target a page with page_id or page_title (appends a block), pass block_id to replace an existing html block, or new_page_title to create a fresh page around the doc. Prefer this over trame_report when you want an answer back from the user.",
  {
    html: z.string(),
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    block_id: z.string().optional(),
    new_page_title: z.string().optional(),
    parent_id: z.string().optional(),
  },
  async (
    args: {
      html: string;
      page_id?: string;
      page_title?: string;
      block_id?: string;
      new_page_title?: string;
      parent_id?: string;
    },
  ) => {
    if (new TextEncoder().encode(args.html).length > HTML_BLOCK_MAX_BYTES) {
      throw new Error(`html is over ${HTML_BLOCK_MAX_BYTES / 1024} KB`);
    }
    if (args.new_page_title) {
      const blockId = crypto.randomUUID().slice(0, 8);
      const r = await post("/api/pages", {
        title: args.new_page_title,
        kind: "page",
        parent_id: args.parent_id ?? null,
        content: [{ type: "html", html: args.html, id: blockId }],
      }) as { id: string };
      return text({ page_id: r.id, block_id: blockId });
    }
    const pageId = await resolvePageId(args);
    const page = await api(`/api/pages/${pageId}`) as {
      content: { type?: string; id?: string; html?: string }[];
    };
    const content = [...(page.content ?? [])];
    let blockId = args.block_id;
    if (blockId) {
      const idx = content.findIndex((b) =>
        b.id === blockId && b.type === "html"
      );
      if (idx < 0) throw new Error(`no html block "${blockId}" on that page`);
      content[idx] = { ...content[idx], html: args.html };
    } else {
      blockId = crypto.randomUUID().slice(0, 8);
      content.push({ type: "html", html: args.html, id: blockId });
    }
    await post(`/api/pages/${pageId}`, { content });
    return text({ page_id: pageId, block_id: blockId });
  },
);

server.tool(
  "trame_html_data",
  "Read back the data an embedded HTML block persisted (what the user picked or submitted in the doc via window.trame.send). block_id is optional when the page has exactly one html block.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    block_id: z.string().optional(),
  },
  async (
    args: { page_id?: string; page_title?: string; block_id?: string },
  ) => {
    const pageId = await resolvePageId(args);
    const page = await api(`/api/pages/${pageId}`) as {
      content: { type?: string; id?: string; data?: unknown }[];
    };
    const htmlBlocks = (page.content ?? []).filter((b) => b.type === "html");
    const target = args.block_id
      ? htmlBlocks.find((b) => b.id === args.block_id)
      : htmlBlocks.length === 1
      ? htmlBlocks[0]
      : undefined;
    if (!target) {
      throw new Error(
        args.block_id
          ? `no html block "${args.block_id}" on that page`
          : `page has ${htmlBlocks.length} html blocks — pass block_id`,
      );
    }
    return text({ block_id: target.id, data: target.data ?? null });
  },
);

server.tool(
  "trame_report",
  "Publish an HTML exploration/report to Trame's Explore view. Pass a complete self-contained HTML document (inline CSS, no external assets).",
  {
    title: z.string(),
    html: z.string(),
    client: z.string().optional(),
    objective: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    text(await post("/api/reports", args)),
);

server.tool(
  "trame_reports",
  "List published reports (metadata only).",
  {},
  async () => text(await api("/api/reports")),
);

server.tool(
  "trame_sync",
  "Push/pull sync between the local db and the hub now.",
  {},
  async () => text(await post("/api/sync", {})),
);

export async function serve() {
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await serve();
