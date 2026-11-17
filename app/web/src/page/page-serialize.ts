// Serialize a page (title + text blocks) to Markdown — "select all → copy" in
// the editor, the "Copy as Markdown" button on the public link viewer.
// Structural blocks (database/subpage/folder/html) have no text and are skipped.

// structural subset both the editor's Block and the link viewer's LinkBlock satisfy
import { todoNumbers } from "../../../../core/page-markdown.ts";

export type MdSourceBlock = {
  type: string;
  text?: string;
  done?: boolean;
  indent?: number;
  numbered?: boolean;
};

export function blocksToMarkdown(
  title: string,
  blocks: readonly MdSourceBlock[],
): string {
  const lines: string[] = [];
  if (title.trim()) lines.push(`# ${title.trim()}`, "");
  const numbers = todoNumbers(blocks);
  for (const [i, b] of blocks.entries()) {
    if (b.type === "heading") lines.push(`## ${b.text}`);
    else if (b.type === "todo") {
      lines.push(
        `${"  ".repeat(b.indent ?? 0)}${numbers[i] ? `${numbers[i]}.` : "-"} [${b.done ? "x" : " "}] ${b.text}`,
      );
    } else if (b.type === "text") {
      lines.push(b.indent ? `${"  ".repeat(b.indent)}${b.text}` : b.text ?? "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
