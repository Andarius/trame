// gh-style session query; the syntax text is shown by the web query box and `tramecli query` / `setup`
import { pagesById, projectOf, sessionTagKeys, storyOf, type TreePage } from "./tree.ts";

export const QUERY_SYNTAX = `Session query (the board's query box, mirrored to ?q=) — gh-style:
  terms AND, commas OR within a key, "-" negates, * globs, "quote spaced values"
  status:active,blocked  tag:p1  project:trame  story:"cli rollout"
  branch:feat/*  repo:  agent:codex  title:  summary:  next:
  assigner:carlo   who handed you the card, from a plugin (e.g. Cockpit)
  has:pr|specs|branch|next|story|project|tags|transcript|assigner   no:specs
  touched:>7d  touched:<2026-09-01   (h/d/w relative, or a date; >= and <= too)
  bare words search title, summary, next step and branch
  e.g. status:active,blocked -has:specs touched:>7d "topbar"
  from a terminal: tramecli list -q '<query>'`;

export type Term = { neg: boolean; key: string | null; values: string[] };

export const QUERY_KEYS = [
  "status", "tag", "project", "story", "branch", "repo", "agent", "title", "summary", "next", "assigner", "touched",
  "has", "no",
] as const;
// matched whole (unless globbed); every other key matches a substring
const EXACT = new Set(["status", "tag", "agent", "has", "no"]);

export function parseQuery(q: string): { terms: Term[]; errors: string[] } {
  const terms: Term[] = [], errors: string[] = [];
  for (const m of q.matchAll(/(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const key = m[2]?.toLowerCase() ?? null;
    const raw = m[3] ?? m[4] ?? "";
    // `status:` with no value yet is a key being typed, not a word to search
    if (!key && raw.endsWith(":") && (QUERY_KEYS as readonly string[]).includes(raw.slice(0, -1).toLowerCase())) continue;
    if (key && !(QUERY_KEYS as readonly string[]).includes(key)) errors.push(`unknown key "${key}"`);
    const values = (key ? raw.split(",") : [raw]).map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (values.length) terms.push({ neg: m[1] === "-", key, values });
  }
  return { terms, errors };
}

// `7d` / `12h` / `2w` → ISO instant that long ago; anything else is taken as a date
function toInstant(v: string, now: number): string {
  const rel = /^(\d+)([hdw])$/.exec(v);
  if (!rel) return v;
  const h = { h: 1, d: 24, w: 168 }[rel[2] as "h" | "d" | "w"];
  return new Date(now - Number(rel[1]) * h * 3_600_000).toISOString();
}

function matchValue(key: string | null, field: string, v: string, now: number): boolean {
  if (v[0] === ">" || v[0] === "<") {
    const bound = toInstant(v.replace(/^[<>]=?/, ""), now);
    const eq = v[1] === "=" && field.startsWith(bound);
    return eq || (v[0] === ">" ? field > bound : field < bound);
  }
  if (v.includes("*")) {
    const re = v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${re}$`).test(field);
  }
  return key && EXACT.has(key) ? field === v : field.includes(v);
}

// `fields(key)` returns the lowercased values of that key for one item; key null = free text
export function matchQuery(terms: Term[], fields: (key: string | null) => string[], now = Date.now()): boolean {
  return terms.every(({ neg, key, values }) => {
    const [k, flip] = key === "no" ? ["has", !neg] : [key, neg];
    const got = fields(k);
    const hit = values.some((v) => got.some((f) => matchValue(k, f, v, now)));
    return hit !== flip;
  });
}

// `assigner:`, `has:assigner`, `no:assigner` need the plugin-provided assigners
export const needsAssigners = (terms: Term[]): boolean =>
  terms.some((t) => t.key === "assigner" || ((t.key === "has" || t.key === "no") && t.values.includes("assigner")));

// the /api/board fields a query reads — the web board and tramecli list share this
export type QuerySession = {
  id: string;
  title: string;
  status: string;
  page_id: string | null;
  client_id: string | null;
  tags?: string[];
  summary?: string | null;
  next_step: string | null;
  branch: string | null;
  repo_path: string | null;
  agent?: string | null;
  specs_page_id?: string | null;
  pr_url: string | null;
  claude_id?: string | null;
  last_touched: string;
};
export type QueryBoard = {
  pages: (TreePage & { tags?: string[] })[];
  statuses: { key: string; label?: string }[];
  projects: { id: string; name: string; icon?: string | null; color?: string | null }[];
};

// who handed me each card, by session id — plugin data (the web's useCardFaces, a plugin's cardFaces route)
export type Assigners = Record<string, { name: string; avatar?: string | null }>;

export function filterSessions<S extends QuerySession>(
  sessions: S[],
  board: QueryBoard,
  query: string,
  assigners: Assigners = {},
): S[] {
  const { terms } = parseQuery(query);
  if (!terms.length) return sessions;
  const byId = pagesById(board.pages);
  const lc = (...xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const fields = (s: S) => (key: string | null): string[] => {
    switch (key) {
      case null: return lc(s.title, s.summary, s.next_step, s.branch);
      case "status": return lc(s.status, board.statuses.find((st) => st.key === s.status)?.label);
      case "tag": return lc(...sessionTagKeys(s, byId));
      case "project": {
        const id = projectOf(s, byId);
        return lc(board.projects.find((p) => p.id === id)?.name ?? byId.get(id ?? "")?.title);
      }
      case "story": return lc(storyOf(s, byId)?.title);
      case "branch": return lc(s.branch);
      case "repo": return lc(s.repo_path);
      case "agent": return lc(s.agent);
      case "title": return lc(s.title);
      case "summary": return lc(s.summary);
      case "next": return lc(s.next_step);
      case "assigner": return lc(assigners[s.id]?.name);
      case "touched": return [s.last_touched];
      case "has": return [
        s.pr_url && "pr", s.specs_page_id && byId.has(s.specs_page_id) && "specs", s.branch && "branch",
        s.next_step && "next", storyOf(s, byId) && "story", projectOf(s, byId) && "project",
        sessionTagKeys(s, byId).length && "tags", s.claude_id && "transcript",
        assigners[s.id] && "assigner",
      ].filter((x): x is string => typeof x === "string");
      default: return [];
    }
  };
  return sessions.filter((s) => matchQuery(terms, fields(s)));
}

// Suggestions
// one line per key for the query box's completion list
export const KEY_HINTS: Record<(typeof QUERY_KEYS)[number], string> = {
  status: "column", tag: "card or story tag", project: "project name", story: "story title", branch: "git branch",
  repo: "repo path", agent: "claude, codex…", title: "card title", summary: "card summary", next: "next step",
  assigner: "who handed you the card", touched: ">7d, <2026-09-01", has: "has a field", no: "lacks a field",
};
export const HAS_VALUES = ["pr", "specs", "branch", "next", "story", "project", "tags", "transcript", "assigner"];

// `avatar` set (null: initials) marks a person; `icon`/`color` are the page's own
export type QueryValue = { value: string; hint?: string; avatar?: string | null; icon?: string | null; color?: string | null };
// `key` and `value` are set on value suggestions, for the list to draw them
export type Suggestion = { label: string; hint?: string; from: number; to: number; insert: string; key?: string; value?: QueryValue };

// the values worth proposing after `key:`, read from the board the box filters
export function queryValues(
  board: QueryBoard & { sessions: QuerySession[] },
  assigners: Assigners = {},
): Record<string, QueryValue[]> {
  const byId = pagesById(board.pages);
  const uniq = (xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)).map((value) => ({ value }));
  const pick = (p?: { icon?: string | null; color?: string | null }) => ({ icon: p?.icon ?? null, color: p?.color ?? null });
  // one row per person, with the first picture any of their cards has
  const faces = new Map<string, string | null>();
  for (const a of Object.values(assigners)) if (!faces.get(a.name)) faces.set(a.name, a.avatar ?? null);
  return {
    status: board.statuses.map((s) => ({ value: s.key, hint: s.label })),
    tag: uniq(board.sessions.flatMap((s) => sessionTagKeys(s, byId))),
    project: uniq(board.projects.map((p) => p.name))
      .map(({ value }) => ({ value, ...pick(board.projects.find((p) => p.name === value)) })),
    story: uniq(board.sessions.map((s) => storyOf(s, byId)?.title))
      .map(({ value }) => ({ value, ...pick(board.pages.find((p) => p.kind === "story" && p.title === value)) })),
    agent: uniq(board.sessions.map((s) => s.agent)),
    assigner: [...faces].sort(([a], [b]) => a.localeCompare(b)).map(([value, avatar]) => ({ value, avatar })),
    has: HAS_VALUES.map((value) => ({ value })),
  };
}

// completions for the token ending at `cursor`: a key while typing one, then its values
export function suggestQuery(query: string, cursor: number, values: Record<string, QueryValue[]>): Suggestion[] {
  if (/\S/.test(query[cursor] ?? "")) return []; // mid-word: stay out of the way
  let start = 0, quoted = false;
  for (let i = 0; i < cursor; i++) {
    if (query[i] === '"') quoted = !quoted;
    else if (!quoted && /\s/.test(query[i])) start = i + 1;
  }
  const token = query.slice(start, cursor);
  const neg = token.startsWith("-") ? "-" : "";
  const body = token.slice(neg.length);
  const colon = body.indexOf(":");
  if (colon < 0) {
    const typed = body.toLowerCase();
    if (!typed || typed.includes('"')) return [];
    return QUERY_KEYS.filter((k) => k.startsWith(typed))
      .map((k) => ({ label: `${k}:`, hint: KEY_HINTS[k], from: start, to: cursor, insert: `${neg}${k}:` }));
  }
  const key = body.slice(0, colon).toLowerCase();
  const raw = body.slice(colon + 1);
  const comma = raw.lastIndexOf(",");
  // a quoted value is the whole value, so it never follows a comma
  const fragment = (comma < 0 ? raw : raw.slice(comma + 1)).replace(/^"/, "").toLowerCase();
  const from = start + neg.length + colon + 1 + (comma < 0 ? 0 : comma + 1);
  const options = (values[key === "no" ? "has" : key] ?? [])
    .filter((v) => v.value.toLowerCase().includes(fragment) && (comma < 0 || !/\s/.test(v.value)))
    .sort((a, b) => Number(!a.value.toLowerCase().startsWith(fragment)) - Number(!b.value.toLowerCase().startsWith(fragment)));
  return options.slice(0, 8).map((v) => ({
    label: v.value,
    hint: v.hint,
    key: key === "no" ? "has" : key,
    value: v,
    from,
    to: cursor,
    insert: `${/\s/.test(v.value) ? `"${v.value}"` : v.value} `,
  }));
}

// the query with `s` applied, and where the caret goes
export function applySuggestion(query: string, s: Suggestion): { query: string; cursor: number } {
  const rest = query.slice(s.to);
  const insert = s.insert.endsWith(" ") && rest.startsWith(" ") ? s.insert.trimEnd() : s.insert;
  return { query: query.slice(0, s.from) + insert + rest, cursor: s.from + insert.length + (insert === s.insert ? 0 : 1) };
}
