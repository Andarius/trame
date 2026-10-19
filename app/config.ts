// Central config, read from env with sane defaults.
// Each laptop MUST have a unique TRACKER_NODE_ID (used as the row `origin` for LWW).
import { hostname } from "node:os";

const home = process.env.HOME ?? ".";
const dataHome = process.env.XDG_DATA_HOME ?? `${home}/.local/share`;

export const NODE_ID = process.env.TRACKER_NODE_ID ?? hostname();
export const DATA_DIR = process.env.TRACKER_DATA_DIR ?? `${dataHome}/trame/pglite`;
// App settings editable from the UI. Device-local, not synced. Overridable for test isolation.
export const SETTINGS_FILE = process.env.TRACKER_SETTINGS_FILE ?? `${dataHome}/trame/settings.json`;
// Working-dir → Project map, JSON: {"<path segment>": <entry>} where an entry is a
// project name or {"project": "...", "tags": ["..."], "repos": ["..."]} — the tags are
// stamped on story pages created for matching sessions, gated by the repo whitelist
// when one is set. e.g. TRACKER_CLIENTS=
// '{"Obitrain":"Obitrain","Work":{"project":"Soren","tags":["infra"],"repos":["sre-config"]}}'.
// Anything unmatched → "Side-projects". Kept out of the repo — set per-machine.
export type ClientEntry = { project: string; tags: string[]; repos?: string[] };
export const CLIENT_MAP: Record<string, ClientEntry> = (() => {
  const raw = (process.env.TRACKER_CLIENTS ?? "").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const map: Record<string, ClientEntry> = {};
    for (const [seg, v] of Object.entries(parsed)) {
      const entry = typeof v === "string" ? { project: v, tags: [] } : v as ClientEntry;
      if (typeof entry?.project !== "string" || !entry.project.trim()) throw new Error(`"${seg}" needs a project name`);
      const tags = entry.tags ?? [];
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !t.trim())) {
        throw new Error(`"${seg}" tags must be strings`);
      }
      if (entry.repos !== undefined && (!Array.isArray(entry.repos) ||
        entry.repos.some((r) => typeof r !== "string" || !r.trim()))) {
        throw new Error(`"${seg}" repos must be strings`);
      }
      map[seg] = { project: entry.project, tags, ...(entry.repos ? { repos: entry.repos } : {}) };
    }
    return map;
  } catch (e) {
    console.error(`TRACKER_CLIENTS ignored (want {"segment":"Project"|{project,tags}} JSON): ${(e as Error).message}`);
    return {};
  }
})();

// A path "contains" a segment as /<seg>/ or trailing /<seg> (the repo's own basename),
// or dash-encoded under /tmp/claude-… (scratchpad worktrees carry the repo path that way).
function hasSegment(path: string, seg: string): boolean {
  if (path.includes(`/${seg}/`) || path.endsWith(`/${seg}`)) return true;
  return path.startsWith("/tmp/claude-") &&
    (path.includes(`-${seg}-`) || path.includes(`-${seg}/`));
}

// First map entry whose segment appears in the path.
export function clientEntryFor(path: string): ClientEntry | null {
  for (const [seg, entry] of Object.entries(CLIENT_MAP)) {
    if (hasSegment(path, seg)) return entry;
  }
  return null;
}

// Tags to stamp on a NEW story for this working dir: the matching entry's tags,
// gated by its repo whitelist when one is set.
export function defaultTagsFor(path: string): string[] {
  const entry = clientEntryFor(path);
  if (!entry?.tags.length) return [];
  if (!entry.repos) return entry.tags;
  return entry.repos.some((r) => hasSegment(path, r)) ? entry.tags : [];
}
