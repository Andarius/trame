// Agent-facing Trame page writer.
//
// Input: one JSON object, as argv[0] or on stdin:
//   create: { title, markdown?, markdown_file?, parent_id?, parent_title?, icon? }
//     Without parent_id/parent_title the page is filed under the project owning the
//     current working directory; parent_id: null forces a root (Unfiled) page.
//   update: { page_id|page_title, markdown|markdown_file, title?, icon? }
//
// Updates replace the page content in place; blocks whose trimmed text is unchanged
// keep their ids so attached comments stay anchored (see app/page-merge.ts).
//
// The running app remains the only database writer. Unlike session tracking, page
// creation is not queued while the app is closed because parent resolution and a
// partially-created document must not be guessed later.
import { PORT_FILE } from "../app/config.ts";
import { markdownToPageBlocks } from "../app/page-markdown.ts";
import { mergePageBlocks } from "../app/page-merge.ts";

type Input = {
  title?: string;
  markdown?: string;
  markdown_file?: string;
  parent_id?: string | null;
  parent_title?: string;
  icon?: string | null;
  page_id?: string;
  page_title?: string;
};

type PageMeta = {
  id: string;
  title: string;
};

type PageDetail = PageMeta & { content?: unknown[] };

async function readInput(): Promise<Input> {
  const arg = Deno.args[0];
  const raw = arg || await new Response(Deno.stdin.readable).text();
  const input = JSON.parse(raw) as Input;
  if (input.markdown !== undefined && input.markdown_file) {
    throw new Error("use markdown or markdown_file, not both");
  }
  if (input.page_id && input.page_title) {
    throw new Error("use page_id or page_title, not both");
  }
  const updating = Boolean(input.page_id || input.page_title);
  if (updating) {
    if (input.parent_id !== undefined || input.parent_title) {
      throw new Error("cannot reparent on update; use trame_move_page");
    }
    if (input.markdown === undefined && !input.markdown_file) {
      throw new Error("update requires markdown or markdown_file");
    }
  } else {
    if (!input.title?.trim()) throw new Error("title is required");
    if (input.parent_id !== undefined && input.parent_title) {
      throw new Error("use parent_id or parent_title, not both");
    }
  }
  return { ...input, title: input.title?.trim() || undefined };
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

async function resolveByTitle(
  base: string,
  title: string,
  role: "page" | "parent",
): Promise<string> {
  const pages = await request(base, "/api/pages") as PageMeta[];
  const matches = pages.filter((p) => p.title === title);
  if (matches.length !== 1) {
    const label = role === "parent" ? "parent page" : "page";
    throw new Error(
      matches.length
        ? `${role}_title "${title}" is ambiguous; use ${role}_id`
        : `${label} "${title}" was not found`,
    );
  }
  return matches[0].id;
}

async function updatePage(input: Input, base: string): Promise<void> {
  const pageId = input.page_title
    ? await resolveByTitle(base, input.page_title, "page")
    : input.page_id!;
  const page = await request(base, `/api/pages/${pageId}`) as PageDetail;
  const markdown = input.markdown_file
    ? await Deno.readTextFile(input.markdown_file)
    : input.markdown ?? "";
  const title = input.title ?? page.title;
  const existing = page.content ?? [];
  const content = mergePageBlocks(existing, markdownToPageBlocks(markdown, title));
  // count only text blocks: structural blocks are always preserved
  const textId = (b: unknown): string | null => {
    const { type, id } = (b ?? {}) as { type?: unknown; id?: unknown };
    return typeof id === "string" &&
        ["text", "heading", "todo"].includes(type as string)
      ? id
      : null;
  };
  const oldIds = new Set(existing.map(textId).filter((id) => id !== null));
  const kept = content.filter((b) => {
    const id = textId(b);
    return id !== null && oldIds.has(id);
  }).length;
  await request(base, `/api/pages/${pageId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      ...(input.title ? { title: input.title } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    }),
  });
  console.log(
    `ok: page ${pageId} updated in Trame (${title}) — kept ${kept} of ${oldIds.size} block ids — ${base}/?page=${pageId}`,
  );
}

// Where the page actually landed — the parent is resolved app-side when none is given.
async function parentLabel(base: string, id: string): Promise<string> {
  const pages = await request(base, "/api/pages") as (PageMeta & { parent_id: string | null })[];
  const parentId = pages.find((p) => p.id === id)?.parent_id;
  return pages.find((p) => p.id === parentId)?.title ?? "Unfiled";
}

async function createPage(input: Input, base: string): Promise<void> {
  let parentId = input.parent_id;
  if (input.parent_title) {
    parentId = await resolveByTitle(base, input.parent_title, "parent");
  }
  const markdown = input.markdown_file
    ? await Deno.readTextFile(input.markdown_file)
    : input.markdown ?? "";
  const body = {
    title: input.title,
    kind: "page",
    // no parent given: the app files the page under this repo's project (explicit
    // null still means a root page)
    ...(parentId !== undefined ? { parent_id: parentId } : { repo_path: Deno.cwd() }),
    icon: input.icon ?? null,
    content: markdownToPageBlocks(markdown, input.title!),
  };
  const { id } = await request(base, "/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as { id: string };

  const parent = await parentLabel(base, id);
  console.log(
    `ok: page ${id} created in Trame (${input.title}) — filed under ${parent} — ${base}/?page=${id}`,
  );
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

  if (input.page_id || input.page_title) await updatePage(input, base);
  else await createPage(input, base);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
