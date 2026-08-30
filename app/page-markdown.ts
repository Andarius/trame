export type PageTextBlock = {
  type: "text" | "heading" | "todo";
  text: string;
  done?: boolean;
  indent?: number;
  id: string;
};

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
// page). Structural blocks (database/subpage/folder/html) have no text and are skipped.
export function pageBlocksToMarkdown(blocks: unknown[]): string {
  const parts: string[] = [];
  let prevTodo = false;
  for (const raw of blocks) {
    const b = raw as Partial<PageTextBlock> & { type?: string };
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
): PageTextBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: PageTextBlock[] = [];
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
