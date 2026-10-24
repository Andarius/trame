// A page with cells as one standalone HTML document: text, code and outputs, both themes.
import type { Block, CellOutput } from "../../api";
import { ansiRuns, outputTheme, pickMime } from "./cell-output";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// enough markdown for a page's prose: bold, italics, inline code, links
function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\n/g, "<br>");
}

const ansiHtml = (text: string) => ansiRuns(text).map((r) => (r.style ? `<span style="${r.style}">${esc(r.text)}</span>` : esc(r.text))).join("");

function output(o: CellOutput): string {
  if (o.output_type === "stream") return `<pre class="out ${o.name}">${ansiHtml(o.text)}</pre>`;
  if (o.output_type === "error") return `<pre class="out error">${ansiHtml(o.traceback.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`)}</pre>`;
  const picked = pickMime(o.data);
  if (!picked) return "";
  const [mime, value] = picked;
  if (mime === "text/html" || mime === "image/svg+xml") return `<div class="rich">${value}</div>`;
  if (mime === "image/png" || mime === "image/jpeg") return `<img src="data:${mime};base64,${value.replace(/\s/g, "")}" alt="">`;
  if (mime === "text/plain" || mime === "text/markdown") return `<pre class="out">${ansiHtml(value)}</pre>`;
  return `<pre class="out">[${esc(mime)}]</pre>`;
}

function block(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h2>${inline(b.text)}</h2>`;
    case "todo":
      return `<p class="todo">${b.done ? "☑" : "☐"} ${inline(b.text)}</p>`;
    case "text": {
      const fence = b.text.match(/^```(\w*)\n([\s\S]*?)\n```\s*$/);
      if (fence) return `<pre class="snippet">${esc(fence[2])}</pre>`;
      return b.text.trim() ? `<p>${inline(b.text)}</p>` : "";
    }
    case "code":
      return `<section class="cell"><div class="n">[${b.count ?? " "}]</div><pre class="src">${esc(b.source)}</pre>` +
        `<div class="outputs">${(b.outputs ?? []).map(output).join("")}</div></section>`;
    case "embed":
      return `<p><a href="${esc(b.url)}">${esc(b.url)}</a></p>`;
    default:
      return "";
  }
}

export function pageToHtml(title: string, blocks: Block[]): string {
  const body = blocks.map(block).filter(Boolean).join("\n");
  const css = `
${outputTheme("dark").replace(":root{", ":root{").replace("background:transparent", "background:var(--trame-bg)")}
@media (prefers-color-scheme: light){${outputTheme("light").replace("background:transparent", "background:var(--trame-bg)")}}
body{max-width:900px;margin:0 auto;padding:32px 24px 64px;font-size:14px}
h1{font-size:22px;margin:0 0 24px}h2{font-size:17px;margin:28px 0 8px}p{margin:8px 0}
code{font-family:ui-monospace,monospace;font-size:12px;background:var(--trame-line);padding:1px 4px;border-radius:4px}
.cell{margin:16px 0;border:1px solid var(--trame-line);border-radius:8px;overflow:hidden;position:relative}
.cell .n{position:absolute;right:8px;top:6px;font:10.5px ui-monospace,monospace;color:var(--trame-muted)}
pre{margin:0;font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.src{padding:10px 12px;background:var(--trame-line)}.snippet{padding:10px 12px;border:1px solid var(--trame-line);border-radius:8px}
.outputs:not(:empty){padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.out{padding:6px 8px;border-radius:6px;border:1px solid var(--trame-line)}.out.stderr{border-color:#e3c56755;background:#e3c5670f}
.out.error{border-color:#e06c7555;background:#e06c750f}.rich{overflow-x:auto}img{max-width:100%;border-radius:6px}
.todo{color:var(--trame-muted)}a{color:var(--trame-accent)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><h1>${esc(title)}</h1>\n${body}\n</body></html>`;
}
