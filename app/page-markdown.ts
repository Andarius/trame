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

export type PageBlock = PageTextBlock | PageFolderBlock;

export type FolderView = "list" | "gallery";

const FOLDER_VIEWS: FolderView[] = ["list", "gallery"];
const DEFAULT_FOLDER_VIEW: FolderView = "list";

// A line that is nothing but `{{trame:folder=<path>}}`, optionally followed by
// `{{trame:view=<list|gallery>}}`.
const FOLDER_LINE =
  /^\s*\{\{trame:folder=([^{}\n]*)\}\}(?:[ \t]*\{\{trame:view=([^{}\n]*)\}\})?\s*$/;

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
// page). Folder blocks round-trip as their one line; the other structural blocks
// (database/subpage/html) have no text form and are skipped.
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
