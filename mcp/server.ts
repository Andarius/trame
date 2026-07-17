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
  "Add an inline Codex or Claude review comment to a Trame page block. Identify the page by id or exact title and the block by id or a unique text quote; Trame supplies the agent avatar.",
  {
    page_id: z.string().optional(),
    page_title: z.string().optional(),
    block_id: z.string().optional(),
    block_text: z.string().optional(),
    body: z.string(),
    agent: z.enum(["codex", "claude"]),
  },
  async (
    args: {
      page_id?: string;
      page_title?: string;
      block_id?: string;
      block_text?: string;
      body: string;
      agent: "codex" | "claude";
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
