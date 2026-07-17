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
        e.stopPropagation(); // don't bubble into a click-to-edit parent (e.g. comment body)
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
  [
    /^`([^`]+)`/,
    (m, k) => (
      <code
        key={k}
        className="rounded bg-panel px-1 py-0.5 font-mono text-[0.92em] text-ink"
      >
        {m[1]}
      </code>
    ),
  ],
  [
    /^\*\*(\S[\s\S]*?\S|\S)\*\*/,
    (m, k) => (
      <strong key={k} className="font-semibold text-ink">
        {renderInline(m[1])}
      </strong>
    ),
  ],
  [
    /^\*(\S[\s\S]*?\S|\S)\*/,
    (m, k) => <em key={k} className="italic">{renderInline(m[1])}</em>,
  ],
  [
    /^~~(\S[\s\S]*?\S|\S)~~/,
    (m, k) => <del key={k} className="opacity-70">{renderInline(m[1])}</del>,
  ],
  [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m, k) => {
    const h = safeHref(m[2]);
    return h ? <Link key={k} href={h}>{renderInline(m[1])}</Link> : m[0];
  }],
  [
    /^(https?:\/\/[^\s<>)]+)/,
    (m, k) => <Link key={k} href={m[1]}>{m[1]}</Link>,
  ],
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

// Dependency-free syntax highlighting for fenced code — a small regex tokenizer that
// builds React <span>s (never innerHTML). Rough by design; unknown langs render plain.
// Palette: keywords copper, strings active, numbers paused, comments ink-muted.
type Hl = "python" | "ts" | "bash" | "json" | "sql";
const HL_ALIAS: Record<string, Hl> = {
  python: "python",
  py: "python",
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  json: "json",
  sql: "sql",
};
const KW: Record<Hl, Set<string>> = {
  python: new Set(
    "def return import from as class if elif else for while in not and or is None True False try except finally raise with yield lambda pass break continue global nonlocal assert del async await match case self None"
      .split(" "),
  ),
  ts: new Set(
    "const let var function return if else for while do switch case break continue class extends implements interface type enum import export from as default new typeof instanceof in of void null undefined true false this super async await yield try catch finally throw public private protected readonly static get set namespace declare keyof satisfies abstract"
      .split(" "),
  ),
  bash: new Set(
    "if then else elif fi for in do done while until case esac function return local export set echo cd source exit break continue"
      .split(" "),
  ),
  json: new Set("true false null".split(" ")),
  sql: new Set(
    "select from where insert into update delete set values create table drop alter add column primary key foreign references default null not and or as join left right inner outer full on group by order having limit offset distinct union all count sum avg min max case when then else end is like between exists asc desc index unique constraint returning"
      .split(" "),
  ),
};

// per-language token shapes (all anchored at the current scan position)
const LINE_COMMENT: Record<Hl, RegExp | null> = {
  python: /^#[^\n]*/,
  bash: /^#[^\n]*/,
  ts: /^\/\/[^\n]*/,
  sql: /^--[^\n]*/,
  json: null,
};
const BLOCK_COMMENT: Record<Hl, RegExp | null> = {
  python: null,
  bash: null,
  ts: /^\/\*[\s\S]*?\*\//,
  sql: /^\/\*[\s\S]*?\*\//,
  json: null,
};
const STRINGS: Record<Hl, RegExp[]> = {
  python: [/^"(?:[^"\\]|\\.)*"/, /^'(?:[^'\\]|\\.)*'/],
  bash: [/^"(?:[^"\\]|\\.)*"/, /^'(?:[^'\\]|\\.)*'/],
  ts: [/^"(?:[^"\\]|\\.)*"/, /^'(?:[^'\\]|\\.)*'/, /^`(?:[^`\\]|\\.)*`/],
  json: [/^"(?:[^"\\]|\\.)*"/],
  sql: [/^'(?:[^'\\]|\\.)*'/, /^"(?:[^"\\]|\\.)*"/],
};
const NUMBER = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const WORD = /^[A-Za-z_$][\w$]*/;

function highlightCode(code: string, lang: Hl): ReactNode[] {
  const out: ReactNode[] = [];
  const kw = KW[lang];
  const ci = lang === "sql"; // SQL keywords are case-insensitive
  let rest = code, plain = "", key = 0;
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  const emit = (t: string, cls: string) => {
    flush();
    out.push(<span key={key++} className={cls}>{t}</span>);
  };
  while (rest) {
    let m: RegExpMatchArray | null;
    const bc = BLOCK_COMMENT[lang], lc = LINE_COMMENT[lang];
    if (bc && (m = rest.match(bc))) {
      emit(m[0], "text-ink-muted");
      rest = rest.slice(m[0].length);
      continue;
    }
    if (lc && (m = rest.match(lc))) {
      emit(m[0], "text-ink-muted");
      rest = rest.slice(m[0].length);
      continue;
    }
    let hit = false;
    for (const s of STRINGS[lang]) {
      if ((m = rest.match(s))) {
        emit(m[0], "text-active");
        rest = rest.slice(m[0].length);
        hit = true;
        break;
      }
    }
    if (hit) continue;
    if ((m = rest.match(NUMBER))) {
      emit(m[0], "text-paused");
      rest = rest.slice(m[0].length);
      continue;
    }
    if (lang === "ts" && (m = rest.match(/^=>/))) {
      emit(m[0], "text-copper");
      rest = rest.slice(2);
      continue;
    }
    if ((m = rest.match(WORD))) {
      const w = m[0];
      if (kw.has(ci ? w.toLowerCase() : w)) emit(w, "text-copper");
      else plain += w;
      rest = rest.slice(w.length);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return out;
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w+#-]*)/);
    if (fence) { // fenced code — the token after ``` is the language
      const label = fence[1];
      const lang = HL_ALIAS[label.toLowerCase()] ?? null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      i++; // closing fence
      const code = buf.join("\n");
      out.push(
        <pre
          key={key++}
          className="relative my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft"
        >
          {label && (
            <span className="pointer-events-none absolute right-1.5 top-1 select-none text-[9px] uppercase tracking-wide text-ink-muted/50">
              {label}
            </span>
          )}
          <code>{lang ? highlightCode(code, lang) : code}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const Tag = `h${Math.min(lvl, 6)}` as keyof JSX.IntrinsicElements;
      out.push(
        <Tag key={key++} className={HEADING[lvl] ?? HEADING[3]}>
          {renderInline(h[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-2 border-line-soft" />);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) { // blockquote
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      out.push(
        <blockquote
          key={key++}
          className="my-1.5 border-l-2 border-chipline pl-2.5 text-ink-muted"
        >
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
        items.push(
          <li key={items.length} className="leading-relaxed">
            {renderInline(m[2])}
          </li>,
        );
        i++;
      }
      out.push(
        ordered
          ? (
            <ol
              key={key++}
              className="my-1 list-decimal space-y-0.5 pl-5 text-ink-soft"
            >
              {items}
            </ol>
          )
          : (
            <ul
              key={key++}
              className="my-1 list-disc space-y-0.5 pl-4 text-ink-soft"
            >
              {items}
            </ul>
          ),
      );
      continue;
    }
    // paragraph: accumulate until a blank line or a block starter; single newlines → <br>
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(
      <p
        key={key++}
        className="my-1 leading-relaxed text-ink-soft first:mt-0 last:mb-0"
      >
        {buf.map((l, j) => (
          <Fragment key={j}>{j > 0 && <br />}{renderInline(l)}</Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

// Render `text` as Markdown. `className` styles the wrapper (e.g. font size context).
export function Markdown(
  { text, className }: { text: string; className?: string },
) {
  return <div className={className}>{renderBlocks(text)}</div>;
}
