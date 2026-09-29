// Agent-facing Trame page-comment writer.
//
// Input: one JSON object, as argv[0] or on stdin:
//   { page_id|page_title, block_id|block_text, body, agent?, meta?, in_reply_to? }
//
// The app injects the canonical agent name/avatar. This writer resolves human-friendly
// page titles and target quotes so callers do not need to discover HTTP routes or UUIDs.
import { apiRequest, appLink, resolveTarget, type Target } from "./target.ts";
import { type AgentKind, resolveCommentBlock } from "../core/agent-comments.ts";

export type CommentInput = {
  page_id?: string;
  page_title?: string;
  block_id?: string;
  block_text?: string;
  body: string;
  agent?: AgentKind;
  // footer stats; model is always required, and claude/codex must send in/out/ms too
  meta?: { model?: string; in?: number; out?: number; ms?: number };
  // comment being answered: marked "answering" before the reply, "answered" after
  in_reply_to?: string;
};
type Input = CommentInput;

type PageMeta = { id: string; title: string };
type PageDetail = PageMeta & { content: unknown[] };

async function readInput(argv: string[]): Promise<Input> {
  const arg = argv[0];
  const raw = arg || await new Response(Deno.stdin.readable).text();
  return JSON.parse(raw) as Input;
}

// The agent actually writing: an explicit id, else the harness we run under.
export function resolveAgent(input: Pick<Input, "agent">): string {
  return input.agent ?? (Deno.env.get("CODEX_THREAD_ID") ? "codex" : "claude");
}

// Harnesses that surface their own usage — they have no excuse for a bare footer.
const STATS_REQUIRED = new Set(["claude", "codex"]);
const STATS: ("in" | "out" | "ms")[] = ["in", "out", "ms"];

function validate(input: Input): Input {
  if (!input.body?.trim()) throw new Error("body is required");
  if (Boolean(input.page_id) === Boolean(input.page_title)) {
    throw new Error("use exactly one of page_id or page_title");
  }
  if (input.block_id && input.block_text) {
    throw new Error("use block_id or block_text, not both");
  }
  // agent is the id of the model actually writing — any id is allowed (codex/claude
  // are branded, others get a generated avatar). Attribute the real model.
  const agent = resolveAgent(input);
  if (!input.meta?.model?.trim()) {
    throw new Error(
      "meta.model is required — the exact model id you run as (e.g. claude-opus-5, gpt-5.6-sol)",
    );
  }
  for (const k of STATS_REQUIRED.has(agent) ? STATS : []) {
    if (typeof input.meta[k] !== "number") {
      throw new Error(
        `meta.${k} is required for ${agent} — pass the run's own ` +
          `${k === "ms" ? "elapsed time in ms" : `${k}put tokens`}, measured not guessed`,
      );
    }
  }
  return { ...input, body: input.body.trim() };
}

const setStatus = (
  target: Target,
  id: string,
  status: "answering" | "answered",
  agent: string,
) =>
  apiRequest(target, `/api/comments/${id}/agent-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, agent }),
  });

// The one comment entrypoint, shared by the CLI and the MCP server: resolves the
// page by title, the block by id or unique quote, then posts with attribution.
export async function addComment(
  raw: Input,
  target: Target,
): Promise<{ id: string; agent: string; page: PageMeta }> {
  const input = validate(raw);
  let pageId = input.page_id;
  if (input.page_title) {
    const pages = await apiRequest(target, "/api/pages") as PageMeta[];
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

  const page = await apiRequest(target, `/api/pages/${pageId}`) as PageDetail;
  const block = resolveCommentBlock(page.content, input);
  const agent = resolveAgent(input);
  if (input.in_reply_to) {
    await setStatus(target, input.in_reply_to, "answering", agent);
  }
  const { id } = await apiRequest(target, "/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      page_id: page.id,
      block_id: block.id,
      anchor: block.text,
      body: input.body,
      agent,
      meta: input.meta,
    }),
  }) as { id: string };
  // the reply is posted: a failing status call must not look like a failed answer
  if (input.in_reply_to) {
    await setStatus(target, input.in_reply_to, "answered", agent).catch((e) =>
      console.error(`warning: reply posted but marking answered failed: ${e.message}`)
    );
  }
  return { id, agent, page: { id: page.id, title: page.title } };
}

export async function main(argv: string[] = Deno.args) {
  const input = await readInput(argv);
  const target = await resolveTarget();

  const res = await addComment(input, target);
  console.log(
    `ok: ${res.agent} comment ${res.id} added to Trame (${res.page.title})${appLink(target, `page=${res.page.id}`)}`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
