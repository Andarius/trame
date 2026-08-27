// Trame MCP server (stdio). Thin wrapper over the running app's HTTP API, so any
// Claude session can read the board, track sessions, and move cards. The app writes
// its bound port to PORT_FILE on startup (random port in desktop mode).
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.12/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.12/server/stdio.js";
import { z } from "npm:zod@^3.24";
import { PORT_FILE } from "../app/config.ts";
import { markdownToPageBlocks } from "../app/page-markdown.ts";
import { mergePageBlocks } from "../app/page-merge.ts";
import { resolveCommentBlock } from "../app/agent-comments.ts";
import { HTML_BLOCK_MAX_BYTES } from "../protocol/html.ts";

async function api(path: string, init?: RequestInit): Promise<unknown> {
  let port: number;
  try {
    port = JSON.parse(await Deno.readTextFile(PORT_FILE)).port;
  } catch {
    throw new Error(
      "Trame app is not running (no port file). Start it with `just dev` or `just serve`.",
    );
  }
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
// when tools or their semantics change.
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
  \`in\`/\`out\`/\`ms\` are optional: pass only numbers you truly know, omit what you
  can't measure (a footer must be real).
- **The watcher loop**: a human may reply to your comment. If the human runs \`just watch\`,
  YOUR agent is invoked to answer that reply — so a thread is a back-and-forth, not a
  one-shot. Your answer posts as the next comment; the watcher fills its meta for you.

## Pages & reports
- **trame_create_page** — create a page from Markdown (not a session card). Nest it under
  the relevant project via parent_id; parentless pages land in the Unfiled inbox.
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
GFM plus: \`## Title {{tab}}\` headings group the blocks below into a tab strip
(consecutive markers = one strip) and \`## Title {{fold}}\` into a collapsible section;
\`- [ ]\`/\`- [x]\` become checkable todos (2 spaces per nesting level);
bullets under a Completed/Done heading render as checks, under Open/Todo/Next/Pending/
Blocked as open rings with a one-click toggle between the two; \`{{text}}\` is a pill
(\`{{green:…}}\` tints it: green|yellow|red|copper|gray); a \`mermaid\` fence renders as a
diagram; PR/MR links become live PR chips and \`#123\` an issue ref. The same
\`{{tab}}\`/\`{{fold}}\` markers work in a session's \`specs\`.

## Sessions (the board)
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
  "trame_track",
  "Create or update a session (upserts by repo_path+branch among open sessions). Client and objective are names — they are resolved or created.",
  {
    title: z.string(),
    status: z.enum(["active", "paused", "blocked", "done"]).optional(),
    client: z.string().optional(),
    objective: z.string().optional(),
    repo_path: z.string().optional(),
    branch: z.string().optional(),
    next_step: z.string().optional(),
    specs: z.string().optional()
      .describe(
        "Markdown spec shown on the session ticket; omitting it never clears the existing spec. " +
          "`## Title {{tab}}` headings render as a tab strip, `## Title {{fold}}` as a collapsible section",
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
  "Create a new Trame page/document from Markdown. Use this instead of putting a document into a session card. Nest it under the relevant project or page: resolve parent_id first (trame_board lists projects; the current session's project usually is the right home). Omit parent_id only for genuinely cross-project documents — parentless pages land in the Unfiled inbox awaiting manual triage. The Markdown dialect (tab/fold section headings, todos, pills, mermaid, PR chips) is listed by trame_capabilities.",
  {
    title: z.string(),
    markdown: z.string().optional(),
    parent_id: z.string().optional(),
    icon: z.string().optional(),
  },
  async (
    { title, markdown, parent_id, icon }: {
      title: string;
      markdown?: string;
      parent_id?: string;
      icon?: string;
    },
  ) => {
    const res = await post("/api/pages", {
      title,
      kind: "page",
      parent_id: parent_id ?? null,
      icon: icon ?? null,
      content: markdownToPageBlocks(markdown ?? "", title),
    }) as Record<string, unknown>;
    return text(
      parent_id ? res : {
        ...res,
        note:
          "created in Unfiled (no parent) — if a project fits, file it with trame_move_page",
      },
    );
  },
);

server.tool(
  "trame_update_page",
  "Replace a Trame page's content from Markdown IN PLACE (full new content, not a diff). Blocks whose text is unchanged keep their ids, so inline comments stay attached; comments on changed blocks detach to their quoted snapshot. Use for revising a page you authored (e.g. a plan revision) — reply to the comments you are addressing BEFORE updating. Structural blocks (html/database/subpage) are preserved. Optional title renames the page. See trame_capabilities for the page Markdown dialect.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    markdown: z.string(),
    title: z.string().optional(),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      markdown: string;
      title?: string;
    },
  ) => {
    const pageId = await resolvePageId(args);
    const page = await api(`/api/pages/${pageId}`) as {
      title: string;
      content?: unknown[];
    };
    const content = mergePageBlocks(
      page.content ?? [],
      markdownToPageBlocks(args.markdown, args.title ?? page.title),
    );
    await post(`/api/pages/${pageId}`, {
      content,
      ...(args.title ? { title: args.title } : {}),
    });
    return text({ page_id: pageId });
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
  "Add an inline agent review comment to a Trame page block. Identify the page by id or exact title and the block by id or a unique text quote. `agent` is the id of the model actually writing (e.g. codex, claude, glm, gemini) — attribute the real model, not the harness seat; codex/claude get a branded avatar, any other id gets a generated one. `meta.model` is required and records the exact model id you are running as (e.g. claude-opus-5, gpt-5.6-sol) — it renders as a footer under the comment. `in`/`out`/`ms` are optional generation stats: pass only numbers you actually know, omit tokens/time you can't measure.",
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
    if (args.block_id && args.block_text) {
      throw new Error("use block_id or block_text, not both");
    }
    const pageId = await resolvePageId(args);
    const page = await api(`/api/pages/${pageId}`) as {
      id: string;
      content: unknown[];
    };
    const target = resolveCommentBlock(page.content, args);
    return text(
      await post("/api/comments", {
        page_id: page.id,
        block_id: target.id,
        anchor: target.text,
        body: args.body,
        agent: args.agent,
        meta: args.meta,
      }),
    );
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

await server.connect(new StdioServerTransport());
