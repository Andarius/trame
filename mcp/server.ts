// Trame MCP server (stdio). Thin wrapper over the running app's HTTP API, so any
// Claude session can read the board, track sessions, and move cards. The app writes
// its bound port to PORT_FILE on startup (random port in desktop mode).
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.12/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.12/server/stdio.js";
import { z } from "npm:zod@^3.24";
import { PORT_FILE } from "../app/config.ts";
import { markdownToPageBlocks } from "../app/page-markdown.ts";
import { resolveCommentBlock } from "../app/agent-comments.ts";

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
- **Optional \`meta\`** {model, in, out, ms} shows a "model · tokens · seconds" footer.
  Only pass numbers you truly know; omit what you can't measure (a footer must be real).
- **The watcher loop**: a human may reply to your comment. If the human runs \`just watch\`,
  YOUR agent is invoked to answer that reply — so a thread is a back-and-forth, not a
  one-shot. Your answer posts as the next comment; the watcher fills its meta for you.

## Pages & reports
- **trame_create_page** — create/nest a standalone page from Markdown (not a session card).
- **trame_report** — publish a self-contained HTML report to the Explore view.

## Sessions (the board)
- **trame_track** — create/update a work session (upsert by repo_path+branch).
- **trame_set_status** — move a card between columns.
- **trame_new_objective** — create the story/epic sessions ladder up to.

## Read / sync
- **trame_board** — read sessions, objectives, clients. **trame_reports** — list reports.
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
  "Read the Trame board: all sessions with status/client/objective/branch/next_step, plus objectives and clients.",
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
  "Create a new standalone or nested Trame page/document from Markdown. Use this instead of putting a document into a session card.",
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
  ) =>
    text(
      await post("/api/pages", {
        title,
        kind: "page",
        parent_id: parent_id ?? null,
        icon: icon ?? null,
        content: markdownToPageBlocks(markdown ?? "", title),
      }),
    ),
);

server.tool(
  "trame_add_comment",
  "Add an inline agent review comment to a Trame page block. Identify the page by id or exact title and the block by id or a unique text quote. `agent` is the id of the model actually writing (e.g. codex, claude, glm, gemini) — attribute the real model, not the harness seat; codex/claude get a branded avatar, any other id gets a generated one. Optional `meta` records honest generation stats {model, in, out, ms} shown as a footer — only pass numbers you actually know; omit tokens/time you can't measure.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    block_id: z.string().optional(),
    block_text: z.string().optional(),
    body: z.string(),
    agent: z.string(),
    meta: z.object({
      model: z.string().optional(),
      in: z.number().optional(),
      out: z.number().optional(),
      ms: z.number().optional(),
    }).optional(),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      block_id?: string;
      block_text?: string;
      body: string;
      agent: string;
      meta?: { model?: string; in?: number; out?: number; ms?: number };
    },
  ) => {
    if (Boolean(args.page_id) === Boolean(args.page_title)) {
      throw new Error("use exactly one of page_id or page_title");
    }
    if (args.block_id && args.block_text) {
      throw new Error("use block_id or block_text, not both");
    }
    let pageId = args.page_id;
    if (args.page_title) {
      const pages = await api("/api/pages") as { id: string; title: string }[];
      const matches = pages.filter((p) => p.title === args.page_title);
      if (matches.length !== 1) {
        throw new Error(
          matches.length
            ? `page_title "${args.page_title}" is ambiguous; use page_id`
            : `page "${args.page_title}" was not found`,
        );
      }
      pageId = matches[0].id;
    }
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
