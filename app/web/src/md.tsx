// Tiny dependency-free Markdown → React renderer. Safe by construction: it builds
// React nodes (never dangerouslySetInnerHTML) and scheme-checks link hrefs. Covers the
// common subset — headings, fenced code, blockquotes, ordered/unordered lists, rules,
// paragraphs; inline code, **bold**, *italic*, ~~strike~~, [links](url), bare URLs
// (PR/MR links render as state chips) and {{pills}} ({{green:text}} ·
// green|yellow|red|copper|gray — handy for table cells).
// Underscore emphasis is intentionally NOT supported so snake_case survives.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { openInBrowser, prInfo, type PrInfo } from "./api";

// ```mermaid fences render as diagrams. The lib (~1.5 MB) is dynamically imported so
// pages without diagrams never load it. The svg-string injection is the one exception
// to the no-innerHTML rule above — mermaid runs with securityLevel 'strict'.
let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;
const getMermaid = () => {
  mermaidReady ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: { fontFamily: "inherit", primaryColor: "#c98a63" },
    });
    return m;
  });
  return mermaidReady;
};
let mermaidSeq = 0;

function MermaidBlock({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getMermaid()
      .then((m) => m.render(`mermaid-${mermaidSeq++}`, text))
      .then(({ svg }) => alive && setSvg(svg))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [text]);
  if (failed) { // bad syntax → show the source like any code block
    return (
      <pre className="my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft">
        <code>{text}</code>
      </pre>
    );
  }
  return svg
    ? (
      <div
        className="my-1.5 overflow-x-auto [&_svg]:max-w-full"
        // deno-lint-ignore react-no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
    : (
      <div className="my-1.5">
        <span className="text-[11px] text-ink-muted">rendering diagram…</span>
      </div>
    );
}

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

// GitHub PR / GitLab MR URLs — bare or as [text](url) links — render as compact
// chips (icon + repo#42 + title + state, ⧉ badge when stacked), matching the
// session drawer's colors; info resolves lazily via /api/pr-state and is cached
// module-wide so each URL fetches once.
const PR_HREF = /^https?:\/\/[^\s<>)]+\/(?:pull|-\/merge_requests)\/\d+(?:[/?#][^\s<>)]*)?$/;
const PR_STATE_COLOR: Record<string, string> = {
  open: "#7bd88f",
  draft: "#8b93a3",
  merged: "#b590e7",
  closed: "#e06c75",
  unknown: "#5a6172",
};
const prInfoCache = new Map<string, PrInfo>();
const prInfoPending = new Map<string, Promise<PrInfo>>();
const getPrInfo = (url: string): Promise<PrInfo> => {
  const done = prInfoCache.get(url);
  if (done) return Promise.resolve(done);
  let p = prInfoPending.get(url);
  if (!p) {
    p = prInfo(url).then((info) => {
      prInfoCache.set(url, info);
      prInfoPending.delete(url);
      return info;
    });
    prInfoPending.set(url, p);
  }
  return p;
};

// repo#42 for GitHub, proj!39 for GitLab (same parsing as the drawer's prLabel)
function prChipLabel(url: string): string {
  try {
    const u = new URL(url);
    const mr = u.pathname.includes("/merge_requests/");
    const m = u.pathname.match(/\/([^/]+)\/(?:pull|-\/merge_requests)\/(\d+)/);
    return m ? `${m[1]}${mr ? "!" : "#"}${m[2]}` : `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

// inline SVGs (octicon-style) so they render on WebKitGTK
function GitHubMark() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16" fill="currentColor"
      aria-hidden="true" className="shrink-0 text-ink-muted"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
function MergeMark() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className="shrink-0 text-ink-muted"
    >
      <circle cx="3.5" cy="3.5" r="1.8" />
      <circle cx="3.5" cy="12.5" r="1.8" />
      <circle cx="12.5" cy="12.5" r="1.8" />
      <path d="M3.5 5.3v5.4M12.5 10.7V7.5c0-1.7-1.3-3-3-3H7.8M9.6 2.7 7.8 4.5l1.8 1.8" />
    </svg>
  );
}

function PrChip({ url, label }: { url: string; label?: string }) {
  const [info, setInfo] = useState<PrInfo>(
    prInfoCache.get(url) ?? { state: "unknown" },
  );
  useEffect(() => {
    let alive = true;
    getPrInfo(url).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [url]);
  const name = label ?? prChipLabel(url);
  const color = PR_STATE_COLOR[info.state] ?? PR_STATE_COLOR.unknown;
  return (
    <a
      href={url}
      title={`${url}${info.title ? ` · ${info.title}` : ""} · ${info.state}${
        info.stack ? ` · ${info.stack}` : ""
      }`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openInBrowser(url);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-chipline bg-panel px-1.5 py-px align-[-1px] font-mono text-[0.82em] text-ink no-underline transition-colors hover:border-copper/60"
    >
      {url.includes("/-/merge_requests/") ? <MergeMark /> : <GitHubMark />}
      <span className="shrink-0">{name}</span>
      {info.title && info.title !== name && (
        <span className="max-w-[240px] truncate font-sans text-ink-muted">
          {info.title}
        </span>
      )}
      {info.state !== "unknown" && (
        <span className="shrink-0" style={{ color }}>{info.state}</span>
      )}
      {info.stack && (
        <span className="shrink-0 text-ink-muted" title={info.stack}>
          ⧉
        </span>
      )}
    </a>
  );
}

// {{text}} pills — an optional known-color prefix ({{green:done}}) tints them; any
// other "word:" stays part of the text. Full class strings so Tailwind sees them.
const PILL_COLORS: Record<string, string> = {
  green: "bg-active/15 text-active",
  yellow: "bg-paused/15 text-paused",
  red: "bg-blocked/15 text-blocked",
  copper: "bg-copper/15 text-copper",
  gray: "border border-chipline bg-panel text-ink-soft",
};

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
  // images before links — same syntax with a leading !
  [/^!\[([^\]]*)\]\(([^)\s]+)\)/, (m, k) => {
    const src = safeHref(m[2]);
    return src
      ? (
        <img
          key={k}
          src={src}
          alt={m[1]}
          loading="lazy"
          className="my-1.5 max-h-96 max-w-full rounded-md border border-line"
        />
      )
      : m[0];
  }],
  [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m, k) => {
    const h = safeHref(m[2]);
    if (!h) return m[0];
    if (PR_HREF.test(h)) return <PrChip key={k} url={h} label={m[1]} />;
    return <Link key={k} href={h}>{renderInline(m[1])}</Link>;
  }],
  // PR/MR chips before generic bare URLs; trailing path/query (e.g. /files) stays in the link
  [
    /^(https?:\/\/[^\s<>)]+\/(?:pull|-\/merge_requests)\/\d+(?:[/?#][^\s<>)]*)?)/,
    (m, k) => <PrChip key={k} url={m[1]} />,
  ],
  [
    /^(https?:\/\/[^\s<>)]+)/,
    (m, k) => <Link key={k} href={m[1]}>{m[1]}</Link>,
  ],
  [
    /^\{\{([^{}\n]+?)\}\}/,
    (m, k) => {
      const cm = m[1].match(/^([a-z]+):\s*(\S[\s\S]*)$/);
      const cls = cm && PILL_COLORS[cm[1]];
      return (
        <span
          key={k}
          className={`inline-block whitespace-nowrap rounded-md px-1.5 py-px font-mono text-[0.82em] ${
            cls ?? PILL_COLORS.gray
          }`}
        >
          {(cls ? cm[2] : m[1]).trim()}
        </span>
      );
    },
  ],
  // issue/PR refs (#126) — copper mono, like the session drawer's PR chips
  [
    /^#\d+\b/,
    (m, k) => (
      <span key={k} className="font-mono text-[0.92em] text-copper">
        {m[0]}
      </span>
    ),
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
    const next = rest.slice(1).search(/[`*~[#!{]|https?:\/\//);
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
  /^\s*>\s?/.test(l) || /^\s*([-*+]|\d+\.)\s+/.test(l) ||
  /^\s*\|.*\|\s*$/.test(l);

// GFM pipe-table row: strip outer pipes, split on unescaped `|`
function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const colAlign = (c: string) =>
  c.startsWith(":") && c.endsWith(":")
    ? "text-center"
    : c.endsWith(":")
    ? "text-right"
    : "text-left";

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

// Session-report styling for bullet lists, driven by the section they sit under
// (Page.tsx maps the preceding heading block to a variant): "done" renders green
// checks with muted text, "open" renders copper rings in a copper-tinted callout.
export type ListVariant = "done" | "open";

// per-row controls (table reorder/comment, open-list mark-done) — only wired by
// the page editor; read-only contexts (comments, drawers) render them inert
type TableOps = {
  onEdit?: (next: string) => void;
  onCommentRow?: (anchor: string) => void;
  onMarkDone?: (item: string) => void;
  onMarkOpen?: (item: string) => void;
  onEditItem?: (item: string, next: string) => void;
};

// click a list item's text to edit just that line in place (page editor only) —
// Enter/blur commits, Escape cancels; links/images/buttons inside keep their clicks
function EditableItem(
  { raw, onCommit, children }: {
    raw: string;
    onCommit: (next: string) => void;
    children: ReactNode;
  },
) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(raw);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (!editing) {
    return (
      <span
        className="min-w-0 cursor-text"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,img,button")) return;
          e.stopPropagation();
          setVal(raw);
          setEditing(true);
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <textarea
      rows={1}
      value={val}
      className="w-full min-w-0 resize-none rounded border-none bg-panel px-1 font-mono text-[12px] leading-relaxed text-ink outline-none"
      ref={(el) => {
        if (el && document.activeElement !== el) {
          grow(el);
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }}
      onChange={(e) => {
        setVal(e.target.value);
        grow(e.target);
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setEditing(false);
          onCommit(val);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(false);
        }
      }}
      onBlur={() => {
        setEditing(false);
        onCommit(val);
      }}
    />
  );
}

// wraps an item's rendered content in the line editor when the page editor wired it
function itemContent(
  t: string,
  ops: TableOps | undefined,
  cls?: string,
): ReactNode {
  return ops?.onEditItem
    ? (
      <EditableItem raw={t} onCommit={(next) => ops.onEditItem!(t, next)}>
        {renderInline(t)}
      </EditableItem>
    )
    : cls
    ? <span className={cls}>{renderInline(t)}</span>
    : renderInline(t);
}

// Card-framed table. When editable: click selects a row (shift = range,
// ctrl/cmd = toggle), ↑/↓ moves the selection, Delete removes it, Escape clears.
function MdTable(
  { header, align, rows, lines, hdrIdx, ops }: {
    header: string[];
    align: (string | undefined)[];
    rows: string[][];
    lines: string[];
    hdrIdx: number;
    ops?: TableOps;
  },
) {
  const editable = Boolean(ops?.onEdit);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // double-clicked cell being edited in place (raw markdown only via the ✏️ toolbar)
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const base = hdrIdx + 2;

  const apply = (rowLines: string[], nextSel: Set<number>) => {
    const next = [...lines];
    next.splice(base, rows.length, ...rowLines);
    setSel(nextSel);
    ops?.onEdit?.(next.join("\n"));
  };
  const moveSel = (dir: -1 | 1) => {
    if (!sel.size) return;
    const rl = lines.slice(base, base + rows.length);
    const flags = rl.map((_, idx) => sel.has(idx));
    const idxs = [...rl.keys()];
    if (dir === 1) idxs.reverse();
    for (const idx of idxs) {
      if (!flags[idx]) continue;
      const j = idx + dir;
      if (j < 0 || j >= rl.length || flags[j]) continue;
      [rl[idx], rl[j]] = [rl[j], rl[idx]];
      [flags[idx], flags[j]] = [flags[j], flags[idx]];
    }
    apply(rl, new Set(flags.flatMap((f, idx) => (f ? [idx] : []))));
  };
  const removeSel = () => {
    if (!sel.size) return;
    apply(
      lines.slice(base, base + rows.length).filter((_, idx) => !sel.has(idx)),
      new Set(),
    );
  };
  // rewrite one cell in its raw line; `then` chains Tab-editing into the next cell
  const commitCell = (
    ri: number,
    ci: number,
    value: string,
    then: { ri: number; ci: number } | null,
  ) => {
    const cells = parseTableRow(lines[base + ri]);
    cells[ci] = value.replaceAll("|", "\\|").trim();
    const next = [...lines];
    next[base + ri] = `| ${cells.join(" | ")} |`;
    setEditing(then);
    if (then) setDraft(parseTableRow(next[base + then.ri])[then.ci] ?? "");
    ops?.onEdit?.(next.join("\n"));
  };

  useEffect(() => {
    if (!sel.size) return;
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // cell edit owns the keys
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSel(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSel(1);
      } else if (e.key === "Escape") {
        setSel(new Set());
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeSel();
      }
    };
    const clear = () => setSel(new Set());
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", clear);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", clear);
    };
  });

  // checkbox column mirrors the List/database selection layout (shiftRange-style)
  const boxClick = (ri: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSel((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && anchor !== null) {
        const on = !cur.has(ri);
        const [lo, hi] = [Math.min(anchor, ri), Math.max(anchor, ri)];
        for (let k = lo; k <= hi; k++) {
          if (on) next.add(k);
          else next.delete(k);
        }
        return next;
      }
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
    setAnchor(ri);
  };

  return (
    <div className="md-table-card my-2 overflow-x-auto rounded-lg border border-line bg-block px-3 py-1">
      <table className="w-full border-collapse text-[0.92em]">
        <thead>
          <tr>
            {editable && (
              <th className="w-6 border-b border-line px-1 py-2">
                <input
                  type="checkbox"
                  title="Select all rows"
                  className={`h-3.5 w-3.5 accent-[#c98a63] ${
                    sel.size ? "" : "opacity-0 hover:opacity-100"
                  }`}
                  checked={rows.length > 0 && sel.size === rows.length}
                  onChange={(e) =>
                    setSel(
                      e.target.checked
                        ? new Set(rows.map((_, idx) => idx))
                        : new Set(),
                    )}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              </th>
            )}
            {header.map((h, ci) => (
              <th
                key={ci}
                className={`border-b border-line px-2.5 py-2 text-[0.8em] font-medium uppercase tracking-wider text-ink-muted ${
                  align[ci] ?? "text-left"
                }`}
              >
                {renderInline(h)}
              </th>
            ))}
            {editable && <th className="w-0 border-b border-line" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={ri}
              className={`group/row border-b border-line-soft/50 last:border-0 ${
                sel.has(ri) ? "bg-copper/[0.06]" : ""
              }`}
            >
              {editable && (
                <td className="w-6 px-1 py-1.5 align-top">
                  <input
                    type="checkbox"
                    title="Select row — shift-click ranges, ↑↓ move, Del remove"
                    className={`h-3.5 w-3.5 accent-[#c98a63] ${
                      sel.size
                        ? ""
                        : "opacity-0 group-hover/row:opacity-100"
                    }`}
                    checked={sel.has(ri)}
                    readOnly
                    // no text selection on shift-click; keep block select/clear out of it
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey) e.preventDefault();
                    }}
                    // toggle in onClick (not onChange): change events have no shiftKey
                    onClick={(e) => boxClick(ri, e)}
                  />
                </td>
              )}
              {r.map((c, ci) => (
                <td
                  key={ci}
                  title={editable && !(editing?.ri === ri && editing?.ci === ci)
                    ? "Double-click to edit"
                    : undefined}
                  onDoubleClick={(e) => {
                    if (!editable) return;
                    e.stopPropagation();
                    document.getSelection()?.removeAllRanges();
                    setEditing({ ri, ci });
                    setDraft(c);
                  }}
                  className={`px-2.5 py-1.5 align-top text-ink-soft ${
                    align[ci] ?? "text-left"
                  }`}
                >
                  {editing?.ri === ri && editing?.ci === ci
                    ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => {
                          if (editing?.ri === ri && editing?.ci === ci) {
                            commitCell(ri, ci, draft, null);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitCell(ri, ci, draft, null);
                          } else if (e.key === "Escape") {
                            setEditing(null);
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            const d = e.shiftKey ? -1 : 1;
                            let nri = ri, nci = ci + d;
                            if (nci >= r.length) {
                              nri = ri + 1;
                              nci = 0;
                            } else if (nci < 0) {
                              nri = ri - 1;
                              nci = r.length - 1;
                            }
                            commitCell(
                              ri,
                              ci,
                              draft,
                              nri >= 0 && nri < rows.length
                                ? { ri: nri, ci: nci }
                                : null,
                            );
                          }
                        }}
                        className="w-full min-w-[80px] border-b border-copper/60 bg-transparent font-[inherit] text-ink outline-none"
                      />
                    )
                    : renderInline(c)}
                </td>
              ))}
              {editable && (
                <td className="w-0 whitespace-nowrap px-1 py-1 align-top">
                  {ops?.onCommentRow && (
                    <button
                      type="button"
                      title="Comment on this row"
                      onClick={(e) => {
                        e.stopPropagation();
                        ops.onCommentRow?.(
                          lines[base + ri].replaceAll("|", " ").trim().slice(
                            0,
                            80,
                          ),
                        );
                      }}
                      className="rounded px-1 text-[11px] text-ink-muted opacity-0 hover:bg-panel hover:text-copper group-hover/row:opacity-100"
                    >
                      💬
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlocks(
  src: string,
  listVariant?: ListVariant,
  ops?: TableOps,
): ReactNode[] {
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
      if (label.toLowerCase() === "mermaid") {
        out.push(<MermaidBlock key={key++} text={code} />);
        continue;
      }
      out.push(
        <pre
          key={key++}
          className="md-snippet-card relative my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft"
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
      const texts: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        texts.push(m[2]);
        i++;
      }
      if (ordered) {
        out.push(
          <ol
            key={key++}
            className="my-1 list-decimal space-y-0.5 pl-5 text-ink-soft"
          >
            {texts.map((t, j) => (
              <li key={j} className="leading-relaxed">{itemContent(t, ops)}</li>
            ))}
          </ol>,
        );
      } else if (listVariant === "done") {
        out.push(
          <ul
            key={key++}
            className="my-1 list-none space-y-1 pl-0 text-ink-muted"
          >
            {texts.map((t, j) => (
              <li key={j} className="flex gap-2 leading-relaxed">
                {ops?.onMarkOpen
                  ? (
                    <button
                      type="button"
                      title="Mark as open"
                      className="w-3.5 shrink-0 pt-px text-center text-[11px] text-active hover:opacity-60"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        // don't bubble into the block's click-to-edit
                        e.stopPropagation();
                        ops.onMarkOpen!(t);
                      }}
                    >
                      ✓
                    </button>
                  )
                  : (
                    <span className="w-3.5 shrink-0 pt-px text-center text-[11px] text-active">
                      ✓
                    </span>
                  )}
                {itemContent(t, ops, "min-w-0")}
              </li>
            ))}
          </ul>,
        );
      } else if (listVariant === "open") {
        out.push(
          <div
            key={key++}
            className="my-1.5 rounded-lg border border-copper/30 bg-copper/[0.06] px-3 py-2"
          >
            <ul className="list-none space-y-1.5 pl-0 text-ink-soft">
              {texts.map((t, j) => (
                <li key={j} className="flex gap-2 leading-relaxed">
                  {ops?.onMarkDone
                    ? (
                      <button
                        type="button"
                        title="Mark as done"
                        className="mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper hover:bg-copper/20"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          // don't bubble into the block's click-to-edit
                          e.stopPropagation();
                          ops.onMarkDone!(t);
                        }}
                      />
                    )
                    : (
                      <span className="mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper" />
                    )}
                  {itemContent(t, ops, "min-w-0")}
                </li>
              ))}
            </ul>
          </div>,
        );
      } else {
        out.push(
          <ul
            key={key++}
            className="my-1 list-disc space-y-0.5 pl-4 text-ink-soft"
          >
            {texts.map((t, j) => (
              <li key={j} className="leading-relaxed">{itemContent(t, ops)}</li>
            ))}
          </ul>,
        );
      }
      continue;
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const hdrIdx = i;
      const align = parseTableRow(lines[i + 1]).map(colAlign);
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push(
        <MdTable
          key={key++}
          header={header}
          align={align}
          rows={rows}
          lines={lines}
          hdrIdx={hdrIdx}
          ops={ops}
        />,
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
// `onEdit`/`onCommentRow`/`onMarkDone` enable per-row controls (page editor only).
export function Markdown(
  {
    text,
    className,
    listVariant,
    onEdit,
    onCommentRow,
    onMarkDone,
    onMarkOpen,
    onEditItem,
  }: {
    text: string;
    className?: string;
    listVariant?: ListVariant;
    onEdit?: (next: string) => void;
    onCommentRow?: (anchor: string) => void;
    onMarkDone?: (item: string) => void;
    onMarkOpen?: (item: string) => void;
    onEditItem?: (item: string, next: string) => void;
  },
) {
  return (
    <div className={className}>
      {renderBlocks(text, listVariant, {
        onEdit,
        onCommentRow,
        onMarkDone,
        onMarkOpen,
        onEditItem,
      })}
    </div>
  );
}
