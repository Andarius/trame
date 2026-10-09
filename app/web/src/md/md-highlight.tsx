import type { ReactNode } from "react";

// Dependency-free syntax highlighting for fenced code — a small regex tokenizer that
// builds React <span>s (never innerHTML). Rough by design; unknown langs render plain.
// Palette: keywords copper, strings active, numbers paused, comments ink-muted.
export type Hl = "python" | "ts" | "bash" | "json" | "sql";
export const HL_ALIAS: Record<string, Hl> = {
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

export function highlightCode(code: string, lang: Hl): ReactNode[] {
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
