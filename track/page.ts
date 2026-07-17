// Agent-facing Trame page writer.
//
// Input: one JSON object, as argv[0] or on stdin:
//   { title, markdown?, markdown_file?, parent_id?, parent_title?, icon? }
//
// The running app remains the only database writer. Unlike session tracking, page
// creation is not queued while the app is closed because parent resolution and a
// partially-created document must not be guessed later.
import { PORT_FILE } from "../app/config.ts";
import { markdownToPageBlocks } from "../app/page-markdown.ts";

type Input = {
  title: string;
  markdown?: string;
  markdown_file?: string;
  parent_id?: string | null;
  parent_title?: string;
  icon?: string | null;
};

type PageMeta = {
  id: string;
  title: string;
};

async function readInput(): Promise<Input> {
  const arg = Deno.args[0];
  const raw = arg || await new Response(Deno.stdin.readable).text();
  const input = JSON.parse(raw) as Input;
  if (!input.title?.trim()) throw new Error("title is required");
  if (input.markdown !== undefined && input.markdown_file) {
    throw new Error("use markdown or markdown_file, not both");
  }
  if (input.parent_id !== undefined && input.parent_title) {
    throw new Error("use parent_id or parent_title, not both");
  }
  return { ...input, title: input.title.trim() };
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

  let parentId = input.parent_id;
  if (input.parent_title) {
    const pages = await request(base, "/api/pages") as PageMeta[];
    const matches = pages.filter((p) => p.title === input.parent_title);
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `parent_title "${input.parent_title}" is ambiguous; use parent_id`
          : `parent page "${input.parent_title}" was not found`,
      );
    }
    parentId = matches[0].id;
  }

  const markdown = input.markdown_file
    ? await Deno.readTextFile(input.markdown_file)
    : input.markdown ?? "";
  const body = {
    title: input.title,
    kind: "page",
    parent_id: parentId ?? null,
    icon: input.icon ?? null,
    content: markdownToPageBlocks(markdown, input.title),
  };
  const { id } = await request(base, "/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as { id: string };

  console.log(
    `ok: page ${id} created in Trame (${input.title}) — ${base}/?page=${id}`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
