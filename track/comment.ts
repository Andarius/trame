// Agent-facing Trame page-comment writer.
//
// Input: one JSON object, as argv[0] or on stdin:
//   { page_id|page_title, block_id|block_text, body, agent?, meta? }
//
// The app injects the canonical agent name/avatar. This writer resolves human-friendly
// page titles and target quotes so callers do not need to discover HTTP routes or UUIDs.
import { PORT_FILE } from "../app/config.ts";
import { type AgentKind, resolveCommentBlock } from "../app/agent-comments.ts";

type Input = {
  page_id?: string;
  page_title?: string;
  block_id?: string;
  block_text?: string;
  body: string;
  agent?: AgentKind;
  // footer stats; model defaults to the agent id server-side — only pass numbers you measured
  meta?: { model?: string; in?: number; out?: number; ms?: number };
};

type PageMeta = { id: string; title: string };
type PageDetail = PageMeta & { content: unknown[] };

async function readInput(): Promise<Input> {
  const arg = Deno.args[0];
  const raw = arg || await new Response(Deno.stdin.readable).text();
  const input = JSON.parse(raw) as Input;
  if (!input.body?.trim()) throw new Error("body is required");
  if (Boolean(input.page_id) === Boolean(input.page_title)) {
    throw new Error("use exactly one of page_id or page_title");
  }
  if (input.block_id && input.block_text) {
    throw new Error("use block_id or block_text, not both");
  }
  // agent is the id of the model actually writing — any id is allowed (codex/claude
  // are branded, others get a generated avatar). Attribute the real model.
  return { ...input, body: input.body.trim() };
}

async function request(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    throw new Error(
      "Trame app is not reachable (stale port file?). Start it with `just dev` or `just serve`.",
    );
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const input = await readInput();
  let port: number;
  try {
    port = JSON.parse(await Deno.readTextFile(PORT_FILE)).port;
  } catch {
    throw new Error(
      "Trame app is not running (no port file). Start it with `just dev` or `just serve`.",
    );
  }
  const base = `http://127.0.0.1:${port}`;

  let pageId = input.page_id;
  if (input.page_title) {
    const pages = await request(base, "/api/pages") as PageMeta[];
    const matches = pages.filter((p) => p.title === input.page_title);
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `page_title "${input.page_title}" is ambiguous; use page_id`
          : `page "${input.page_title}" was not found`,
      );
    }
    pageId = matches[0].id;
  }

  const page = await request(base, `/api/pages/${pageId}`) as PageDetail;
  const target = resolveCommentBlock(page.content, input);
  const agent = input.agent ??
    (Deno.env.get("CODEX_THREAD_ID") ? "codex" : "claude");
  const { id } = await request(base, "/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      page_id: page.id,
      block_id: target.id,
      anchor: target.text,
      body: input.body,
      agent,
      meta: input.meta,
    }),
  }) as { id: string };

  console.log(
    `ok: ${agent} comment ${id} added to Trame (${page.title}) — ${base}/?page=${page.id}`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
