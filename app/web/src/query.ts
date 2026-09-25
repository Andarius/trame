// gh-style session query; the syntax text is shown by the web query box and `tramecli query` / `setup`
import { pagesById, projectOf, sessionTagKeys, storyOf, type TreePage } from "./tree.ts";

export const QUERY_SYNTAX = `Session query (the board's query box, mirrored to ?q=) — gh-style:
  terms AND, commas OR within a key, "-" negates, * globs, "quote spaced values"
  status:active,blocked  tag:p1  project:trame  story:"cli rollout"
  branch:feat/*  repo:  agent:codex  title:  summary:  next:
  has:pr|specs|branch|next|story|project|tags|transcript   no:specs
  touched:>7d  touched:<2026-09-01   (h/d/w relative, or a date; >= and <= too)
  bare words search title, summary, next step and branch
  e.g. status:active,blocked -has:specs touched:>7d "topbar"
  from a terminal: tramecli list -q '<query>'`;

export type Term = { neg: boolean; key: string | null; values: string[] };

export const QUERY_KEYS = [
  "status", "tag", "project", "story", "branch", "repo", "agent", "title", "summary", "next", "touched", "has", "no",
] as const;
// matched whole (unless globbed); every other key matches a substring
const EXACT = new Set(["status", "tag", "agent", "has", "no"]);

export function parseQuery(q: string): { terms: Term[]; errors: string[] } {
  const terms: Term[] = [], errors: string[] = [];
  for (const m of q.matchAll(/(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const key = m[2]?.toLowerCase() ?? null;
    const raw = m[3] ?? m[4] ?? "";
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

// the /api/board fields a query reads — the web board and tramecli list share this
export type QuerySession = {
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
  projects: { id: string; name: string }[];
};

export function filterSessions<S extends QuerySession>(sessions: S[], board: QueryBoard, query: string): S[] {
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
      case "touched": return [s.last_touched];
      case "has": return [
        s.pr_url && "pr", s.specs_page_id && byId.has(s.specs_page_id) && "specs", s.branch && "branch",
        s.next_step && "next", storyOf(s, byId) && "story", projectOf(s, byId) && "project",
        sessionTagKeys(s, byId).length && "tags", s.claude_id && "transcript",
      ].filter((x): x is string => typeof x === "string");
      default: return [];
    }
  };
  return sessions.filter((s) => matchQuery(terms, fields(s)));
}
