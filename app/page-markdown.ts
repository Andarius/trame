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
