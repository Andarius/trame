export type PageTextBlock = {
  type: "text" | "heading" | "todo";
  text: string;
  done?: boolean;
  indent?: number;
  id: string;
};

// The structural blocks the dialect can express. A folder block's whole payload is
// a path and a view, so one line carries it; blocks with a body (html) do not fit.
export type PageFolderBlock = {
  type: "folder";
  path: string;
  view: FolderView;
  id: string;
};

// An https URL shown live in an iframe; `height` (px) is left out at the default.
export type PageEmbedBlock = {
  type: "embed";
  url: string;
  height?: number;
  id: string;
};

export const EMBED_DEFAULT_HEIGHT = 600;

// A database shown at this point of the page, by id.
export type PageDatabaseBlock = {
  type: "database";
  db_id: string;
  id: string;
};

export type PageBlock = PageTextBlock | PageFolderBlock | PageEmbedBlock | PageDatabaseBlock;

export type FolderView = "list" | "gallery";

const FOLDER_VIEWS: FolderView[] = ["list", "gallery"];
const DEFAULT_FOLDER_VIEW: FolderView = "list";

// A line that is nothing but `{{trame:folder=<path>}}`, optionally followed by
// `{{trame:view=<list|gallery>}}`.
const FOLDER_LINE =
  /^\s*\{\{trame:folder=([^{}\n]*)\}\}(?:[ \t]*\{\{trame:view=([^{}\n]*)\}\})?\s*$/;

// A line that is nothing but `{{trame:embed=<https-url>}}`, optionally followed by
// `{{trame:height=<px>}}`.
const EMBED_LINE =
  /^\s*\{\{trame:embed=([^{}\n]*)\}\}(?:[ \t]*\{\{trame:height=([^{}\n]*)\}\})?\s*$/;

// A line that is nothing but `{{trame:db=<database id>}}`.
const DATABASE_LINE = /^\s*\{\{trame:db=([^{}\n]*)\}\}\s*$/;

export const isDatabaseBlock = (b: unknown): b is PageDatabaseBlock =>
  typeof b === "object" && b !== null &&
  (b as PageDatabaseBlock).type === "database";

function databaseLine(line: string): PageDatabaseBlock | null {
  const dbId = line.match(DATABASE_LINE)?.[1].trim();
  return dbId ? { type: "database", db_id: dbId, id: crypto.randomUUID() } : null;
}

export const databaseMarkup = (b: PageDatabaseBlock): string => `{{trame:db=${b.db_id}}}`;

export const isFolderBlock = (b: unknown): b is PageFolderBlock =>
  typeof b === "object" && b !== null &&
  (b as PageFolderBlock).type === "folder";

function folderLine(line: string): PageFolderBlock | null {
  const m = line.match(FOLDER_LINE);
  if (!m) return null;
  const path = m[1].trim();
  if (!path) return null; // an empty path would render as a dead block
  const view = FOLDER_VIEWS.find((v) => v === m[2]?.trim());
  return {
    type: "folder",
    path,
    view: view ?? DEFAULT_FOLDER_VIEW,
    id: crypto.randomUUID(),
  };
}

function embedLine(line: string): PageEmbedBlock | null {
  const m = line.match(EMBED_LINE);
  if (!m) return null;
  const url = m[1].trim();
  if (!/^https:\/\/\S+$/.test(url)) return null; // only https, one token
  const h = /^[0-9]{1,4}$/.test(m[2]?.trim() ?? "") ? Number(m[2].trim()) : 0;
  return {
    type: "embed",
    url,
    ...(h > 0 && h !== EMBED_DEFAULT_HEIGHT ? { height: h } : {}),
    id: crypto.randomUUID(),
  };
}

export const isEmbedBlock = (b: unknown): b is PageEmbedBlock =>
  typeof b === "object" && b !== null &&
  (b as PageEmbedBlock).type === "embed";

// The default height is left implicit, like the folder's default view.
export function embedMarkup(b: PageEmbedBlock): string {
  const h = b.height && b.height !== EMBED_DEFAULT_HEIGHT
    ? ` {{trame:height=${b.height}}}`
    : "";
  return `{{trame:embed=${b.url}}}${h}`;
}

// The default view is left implicit, so the common case stays a single mark.
export function folderMarkup(b: PageFolderBlock): string {
  const view = b.view && b.view !== DEFAULT_FOLDER_VIEW
    ? ` {{trame:view=${b.view}}}`
    : "";
  return `{{trame:folder=${b.path}}}${view}`;
}

const block = (
  type: PageTextBlock["type"],
  text: string,
  done?: boolean,
  indent?: number,
): PageTextBlock => ({
  type,
  text,
  ...(type === "todo" ? { done: Boolean(done) } : {}),
  ...(indent ? { indent } : {}),
  id: crypto.randomUUID(),
});

// Inverse of markdownToPageBlocks, for agent reads of a page (e.g. a session's spec
// page). Folder, embed and database blocks round-trip as their one line; the other
// structural blocks (subpage/html) have no text form and are skipped.
export function pageBlocksToMarkdown(blocks: unknown[]): string {
  const parts: string[] = [];
  let prevTodo = false;
  for (const raw of blocks) {
    const b = raw as Partial<PageTextBlock> & { type?: string };
    if (isFolderBlock(raw)) {
      prevTodo = false;
      if (raw.path) parts.push(folderMarkup(raw));
      continue;
    }
    if (isEmbedBlock(raw)) {
      prevTodo = false;
      if (raw.url) parts.push(embedMarkup(raw));
      continue;
    }
    if (isDatabaseBlock(raw)) {
      prevTodo = false;
      if (raw.db_id) parts.push(databaseMarkup(raw));
      continue;
    }
    if (b.type === "todo") {
      const line = `${"  ".repeat(b.indent ?? 0)}- [${b.done ? "x" : " "}] ${b.text ?? ""}`;
      // consecutive todos stay one list; blank lines only between other blocks
      if (prevTodo) parts[parts.length - 1] += `\n${line}`;
      else parts.push(line);
      prevTodo = true;
      continue;
    }
    prevTodo = false;
    if (b.type === "heading") parts.push(`## ${b.text ?? ""}`);
    else if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

// Convert the Markdown subset that has native Trame blocks. Everything else stays
// in text blocks, so list, code-fence, link, and inline-formatting syntax is never
// discarded even though the page editor does not have dedicated block types.
export function markdownToPageBlocks(
  markdown: string,
  pageTitle = "",
): PageBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: PageBlock[] = [];
  let buf: string[] = [];
  let inFence = false;
  let firstContent = true;

  const flush = () => {
    while (buf[0]?.trim() === "") buf.shift();
    while (buf.at(-1)?.trim() === "") buf.pop();
    if (buf.length) out.push(block("text", buf.join("\n")));
    buf = [];
  };

  for (const line of lines) {
    if (inFence) {
      buf.push(line);
      if (/^\s*```\s*$/.test(line)) inFence = false;
      continue;
    }
    if (/^\s*```/.test(line)) {
      flush();
      buf.push(line);
      inFence = true;
      firstContent = false;
      continue;
    }

    const folder = folderLine(line);
    if (folder) {
      flush();
      out.push(folder);
      firstContent = false;
      continue;
    }

    const embed = embedLine(line);
    if (embed) {
      flush();
      out.push(embed);
      firstContent = false;
      continue;
    }

    const database = databaseLine(line);
    if (database) {
      flush();
      out.push(database);
      firstContent = false;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const text = heading[2].trim();
      // A document's leading H1 is normally the page title. Avoid rendering it twice.
      if (
        !(
          firstContent &&
          heading[1].length === 1 &&
          text === pageTitle.trim()
        )
      ) {
        out.push(block("heading", text));
      }
      firstContent = false;
      continue;
    }

    const todo = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      flush();
      // two spaces (or one tab) of leading whitespace per nesting level
      const indent = Math.min(
        4,
        Math.floor(todo[1].replace(/\t/g, "  ").length / 2),
      );
      out.push(block("todo", todo[3], todo[2].toLowerCase() === "x", indent));
      firstContent = false;
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
    firstContent = false;
  }
  flush();
  return out;
}
