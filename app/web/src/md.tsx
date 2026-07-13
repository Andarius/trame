// Tiny dependency-free Markdown → React renderer. Safe by construction: it builds
// React nodes (never dangerouslySetInnerHTML) and scheme-checks link hrefs. Covers the
// common subset — headings, fenced code, blockquotes, ordered/unordered lists, rules,
// paragraphs; inline code, **bold**, *italic*, ~~strike~~, [links](url) and bare URLs.
// Underscore emphasis is intentionally NOT supported so snake_case survives.
import { Fragment, type ReactNode } from "react";
import { openInBrowser } from "./api";

const safeHref = (url: string): string | undefined =>
  /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url.trim() : undefined;

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-copper underline decoration-copper/40 underline-offset-2 hover:decoration-copper"
      onClick={(e) => {
        e.preventDefault();
        openInBrowser(href);
      }}
    >
      {children}
    </a>
  );
}

// inline tokens, tried in order at the current position. \S boundaries keep "a * b" and
// trailing/leading spaces from being read as emphasis.
const INLINE: [RegExp, (m: RegExpMatchArray, k: number) => ReactNode][] = [
  [/^`([^`]+)`/, (m, k) => <code key={k} className="rounded bg-panel px-1 py-0.5 font-mono text-[0.92em] text-ink">{m[1]}</code>],
  [/^\*\*(\S[\s\S]*?\S|\S)\*\*/, (m, k) => <strong key={k} className="font-semibold text-ink">{renderInline(m[1])}</strong>],
  [/^\*(\S[\s\S]*?\S|\S)\*/, (m, k) => <em key={k} className="italic">{renderInline(m[1])}</em>],
  [/^~~(\S[\s\S]*?\S|\S)~~/, (m, k) => <del key={k} className="opacity-70">{renderInline(m[1])}</del>],
  [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m, k) => {
    const h = safeHref(m[2]);
    return h ? <Link key={k} href={h}>{renderInline(m[1])}</Link> : m[0];
  }],
  [/^(https?:\/\/[^\s<>)]+)/, (m, k) => <Link key={k} href={m[1]}>{m[1]}</Link>],
];

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text, key = 0;
  while (rest) {
    let hit = false;
    for (const [re, make] of INLINE) {
      const m = rest.match(re);
      if (m) {
        out.push(make(m, key++));
        rest = rest.slice(m[0].length);
        hit = true;
        break;
      }
    }
    if (hit) continue;
    // consume plain text up to the next possible token start (always ≥1 char → no loop)
    const next = rest.slice(1).search(/[`*~[]|https?:\/\//);
    const take = next === -1 ? rest.length : next + 1;
    out.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return out;
}

const HEADING: Record<number, string> = {
  1: "mb-1 mt-2 text-[1.15em] font-semibold text-ink first:mt-0",
  2: "mb-1 mt-2 text-[1.08em] font-semibold text-ink first:mt-0",
  3: "mb-0.5 mt-1.5 text-[1em] font-semibold text-ink first:mt-0",
};
const isBlockStart = (l: string) =>
  /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l) ||
  /^\s*>\s?/.test(l) || /^\s*([-*+]|\d+\.)\s+/.test(l);

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^\s*```/.test(line)) { // fenced code
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(
        <pre key={key++} className="my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const Tag = `h${Math.min(lvl, 6)}` as keyof JSX.IntrinsicElements;
      out.push(<Tag key={key++} className={HEADING[lvl] ?? HEADING[3]}>{renderInline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(<hr key={key++} className="my-2 border-line-soft" />); i++; continue; }

    if (/^\s*>\s?/.test(line)) { // blockquote
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++} className="my-1.5 border-l-2 border-chipline pl-2.5 text-ink-muted">
          {renderBlocks(buf.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    const listM = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (listM) {
      const ordered = /\d+\./.test(listM[1]);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(<li key={items.length} className="leading-relaxed">{renderInline(m[2])}</li>);
        i++;
      }
      out.push(
        ordered
          ? <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5 text-ink-soft">{items}</ol>
          : <ul key={key++} className="my-1 list-disc space-y-0.5 pl-4 text-ink-soft">{items}</ul>,
      );
      continue;
    }
    // paragraph: accumulate until a blank line or a block starter; single newlines → <br>
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(
      <p key={key++} className="my-1 leading-relaxed text-ink-soft first:mt-0 last:mb-0">
        {buf.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{renderInline(l)}</Fragment>)}
      </p>,
    );
  }
  return out;
}

// Render `text` as Markdown. `className` styles the wrapper (e.g. font size context).
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{renderBlocks(text)}</div>;
}
