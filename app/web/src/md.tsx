// Tiny dependency-free Markdown → React renderer. Safe by construction: it builds
// React nodes (never dangerouslySetInnerHTML) and scheme-checks link hrefs. Covers the
// common subset — headings, fenced code, blockquotes, ordered/unordered lists, rules,
// paragraphs; inline code, **bold**, *italic*, ~~strike~~, [links](url), bare URLs and
// {{pills}} ({{green:text}} · green|yellow|red|copper|gray — handy for table cells).
// Underscore emphasis is intentionally NOT supported so snake_case survives.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { openInBrowser } from "./api";

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
    return h ? <Link key={k} href={h}>{renderInline(m[1])}</Link> : m[0];
  }],
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

// per-row table controls (reorder / comment) — only wired by the page editor;
// read-only contexts (comments, drawers) render plain tables
type TableOps = {
  onEdit?: (next: string) => void;
  onCommentRow?: (anchor: string) => void;
};

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
              <li key={j} className="leading-relaxed">{renderInline(t)}</li>
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
                <span className="w-3.5 shrink-0 pt-px text-center text-[11px] text-active">
                  ✓
                </span>
                <span className="min-w-0">{renderInline(t)}</span>
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
                  <span className="mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper" />
                  <span className="min-w-0">{renderInline(t)}</span>
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
              <li key={j} className="leading-relaxed">{renderInline(t)}</li>
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
// `onEdit`/`onCommentRow` enable per-row table controls (page editor only).
export function Markdown(
  { text, className, listVariant, onEdit, onCommentRow }: {
    text: string;
    className?: string;
    listVariant?: ListVariant;
    onEdit?: (next: string) => void;
    onCommentRow?: (anchor: string) => void;
  },
) {
  return (
    <div className={className}>
      {renderBlocks(text, listVariant, { onEdit, onCommentRow })}
    </div>
  );
}
