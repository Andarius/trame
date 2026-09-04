// Central config, read from env with sane defaults.
// Each laptop MUST have a unique TRACKER_NODE_ID (used as the row `origin` for LWW).

const home = Deno.env.get("HOME") ?? ".";
const dataHome = Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;

export const NODE_ID = Deno.env.get("TRACKER_NODE_ID") ?? Deno.hostname();

// Root for on-disk assets (web/dist, db/schema.sql). Under `deno desktop` the code is
// compiled (import.meta.url is virtual), so resolve these against the launch cwd.
// `just dev`/`just serve` both run from app/, so cwd = app/.
export const APP_ROOT = Deno.env.get("TRACKER_APP_ROOT") ?? Deno.cwd();

// The hub's CA (ca.crt) — fetched by `just hub-ca`.
export const TLS_DIR = Deno.env.get("TRACKER_TLS_DIR") ?? `${dataHome}/trame/certs`;

export const DATA_DIR = Deno.env.get("TRACKER_DATA_DIR") ?? `${dataHome}/trame/pglite`;
export const OUTBOX = Deno.env.get("TRACKER_OUTBOX") ?? `${dataHome}/trame/outbox.jsonl`;
// Written by the app on startup so the CLI/MCP can find the (possibly random) port.
export const PORT_FILE = Deno.env.get("TRACKER_PORT_FILE") ?? `${dataHome}/trame/port.json`;
// cwd → current Claude session map, written by the UserPromptSubmit hook (track/claude-hook.ts)
// and read by track/track.ts to attach the Claude session UUID to tracked cards.
export const CLAUDE_MAP = Deno.env.get("TRACKER_CLAUDE_MAP") ?? `${dataHome}/trame/claude-sessions.json`;
// Persisted window geometry (desktop mode).
export const WINDOW_FILE = `${dataHome}/trame/window.json`;
// App settings editable from the UI (report folders, …). Device-local, not synced.
// Overridable for test isolation.
export const SETTINGS_FILE = Deno.env.get("TRACKER_SETTINGS_FILE") ??
  `${dataHome}/trame/settings.json`;
export const HOME_DIR = home;
// Claude Code transcript store (one dir per project cwd), overridable for test fixtures.
export const CLAUDE_DIR = Deno.env.get("TRACKER_CLAUDE_DIR") ?? `${home}/.claude/projects`;
// Codex rollout store (date-partitioned JSONL), overridable for test fixtures.
export const CODEX_DIR = Deno.env.get("TRACKER_CODEX_DIR") ?? `${home}/.codex/sessions`;
// Colon-separated directories scanned for *.html exploration reports (Explore view).
export const REPORT_PATHS = (Deno.env.get("TRACKER_REPORT_PATHS") ?? "")
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => p.replace(/^~(?=\/|$)/, home));
// Working-dir → Project map, JSON: {"<path segment>": "<project name>"}; a segment may
// alias another name, e.g. TRACKER_CLIENTS='{"Obitrain":"Obitrain","Work":"Soren"}'.
// Anything unmatched → "Side-projects". Kept out of the repo — set per-machine.
export const CLIENT_MAP: Record<string, string> = (() => {
  const raw = (Deno.env.get("TRACKER_CLIENTS") ?? "").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    for (const v of Object.values(parsed)) {
      if (typeof v !== "string" || !v.trim()) throw new Error("values must be project names");
    }
    return parsed as Record<string, string>;
  } catch (e) {
    console.error(`TRACKER_CLIENTS ignored (want {"segment":"Project"} JSON): ${(e as Error).message}`);
    return {};
  }
})();
export const PORT = Number(Deno.env.get("TRACKER_PORT") ?? "8787");
// Headless serve binds loopback by default — the API exposes local data (and plugin
// state); set TRACKER_HOST=0.0.0.0 to deliberately serve over the LAN.
export const HOST = Deno.env.get("TRACKER_HOST") ?? "127.0.0.1";
export const SYNC_INTERVAL_MS = Number(Deno.env.get("TRACKER_SYNC_MS") ?? "15000");
// Deployments plugin: adaptive poll cadence — idle by default, fast while a
// pipeline is in flight on a watched GitLab project's default branch (catches
// the approval gate within seconds), then back to idle. Plus an offline
// fixture (JSON file) for tests/demos.
export const DEPLOYMENTS_POLL_IDLE_MS = Number(
  Deno.env.get("TRACKER_DEPLOYMENTS_POLL_IDLE_MS") ?? "300000",
);
export const DEPLOYMENTS_POLL_ACTIVE_MS = Number(
  Deno.env.get("TRACKER_DEPLOYMENTS_POLL_ACTIVE_MS") ?? "10000",
);
export const DEPLOYMENTS_FIXTURE = Deno.env.get("TRACKER_DEPLOYMENTS_FIXTURE") ?? "";
// Cockpit plugin: mirrors tickets from a Cockpit instance's /api/sync. One
// cadence only — tickets move on human timescales, so there is no fast mode to
// justify. Same offline fixture escape hatch as deployments.
export const COCKPIT_POLL_IDLE_MS = Number(
  Deno.env.get("TRACKER_COCKPIT_POLL_IDLE_MS") ?? "300000",
);
export const COCKPIT_FIXTURE = Deno.env.get("TRACKER_COCKPIT_FIXTURE") ?? "";
// Pasted-image storage: files under ASSETS_DIR by default; an S3-compatible bucket
// when TRACKER_S3_ENDPOINT + TRACKER_S3_BUCKET (+ keys) are set.
export const ASSETS_DIR = Deno.env.get("TRACKER_ASSETS_DIR") ?? `${dataHome}/trame/assets`;
export const S3_ENDPOINT = Deno.env.get("TRACKER_S3_ENDPOINT") ?? ""; // e.g. https://s3.fr-par.scw.cloud
export const S3_BUCKET = Deno.env.get("TRACKER_S3_BUCKET") ?? "";
export const S3_REGION = Deno.env.get("TRACKER_S3_REGION") ?? "";
export const S3_ACCESS_KEY = Deno.env.get("TRACKER_S3_ACCESS_KEY") ?? "";
export const S3_SECRET_KEY = Deno.env.get("TRACKER_S3_SECRET_KEY") ?? "";
export const S3_PREFIX = Deno.env.get("TRACKER_S3_PREFIX") ?? "trame-assets/";
