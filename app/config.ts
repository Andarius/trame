// Central config, read from env with sane defaults.
// Each laptop MUST have a unique TRACKER_NODE_ID (used as the row `origin` for LWW).

const home = Deno.env.get("HOME") ?? ".";
const dataHome = Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;

export const NODE_ID = Deno.env.get("TRACKER_NODE_ID") ?? Deno.hostname();

// Root for on-disk assets (web/dist, db/schema.sql). Under `deno desktop` the code is
// compiled (import.meta.url is virtual), so resolve these against the launch cwd.
// `just dev`/`just serve` both run from app/, so cwd = app/.
export const APP_ROOT = Deno.env.get("TRACKER_APP_ROOT") ?? Deno.cwd();

// Postgres on the hub, reachable over the LAN (or Tailscale), e.g.
//   postgres://tracker:PASS@hub:5433/tracker
export const REMOTE_PG = Deno.env.get("TRACKER_REMOTE_PG") ?? "";

// Client TLS material for the hub (ca.crt, client.crt, client.key) — fetched by `just db-cert`.
export const TLS_DIR = Deno.env.get("TRACKER_TLS_DIR") ?? `${dataHome}/session-tracker/certs`;

export const DATA_DIR = Deno.env.get("TRACKER_DATA_DIR") ?? `${dataHome}/session-tracker/pglite`;
export const OUTBOX = Deno.env.get("TRACKER_OUTBOX") ?? `${dataHome}/session-tracker/outbox.jsonl`;
// Written by the app on startup so the CLI/MCP can find the (possibly random) port.
export const PORT_FILE = Deno.env.get("TRACKER_PORT_FILE") ?? `${dataHome}/session-tracker/port.json`;
// cwd → current Claude session map, written by the UserPromptSubmit hook (track/claude-hook.ts)
// and read by track/track.ts to attach the Claude session UUID to tracked cards.
export const CLAUDE_MAP = Deno.env.get("TRACKER_CLAUDE_MAP") ?? `${dataHome}/session-tracker/claude-sessions.json`;
// Persisted window geometry (desktop mode).
export const WINDOW_FILE = `${dataHome}/session-tracker/window.json`;
// App settings editable from the UI (report folders, …). Device-local, not synced.
// Overridable for test isolation.
export const SETTINGS_FILE = Deno.env.get("TRACKER_SETTINGS_FILE") ??
  `${dataHome}/session-tracker/settings.json`;
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
