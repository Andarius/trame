// Deno-desktop entrypoint. `deno desktop main.ts` (Deno 2.9+) opens a native window
// pointed at this in-process HTTP server. `deno task serve` runs it headless (open in a
// browser) if you don't have the desktop subcommand yet.
import {
  APP_ROOT,
  CLAUDE_DIR,
  CODEX_DIR,
  DATA_DIR,
  HOST,
  NODE_ID,
  PORT,
  PORT_FILE,
  REPORT_PATHS,
  SYNC_INTERVAL_MS,
  WINDOW_FILE,
} from "./config.ts";
import {
  handlePluginRoute,
  listPluginManifests,
  startPlugins,
} from "./plugins/index.ts";
import { isCrossSite } from "./csrf.ts";
import { type LaunchMode, shq, spawnTerminal } from "./terminal.ts";
import {
  deleteReportFile,
  getLinkBase,
  getRemotePg,
  getReportPaths,
  listFolder,
  readReportFile,
  resolveAllowedPath,
  resolveRemotePg,
  saveExploreSettings,
  scanReportFiles,
  writeReportFile,
} from "./files.ts";
import { ASSETS } from "./embed.ts";
import {
  addEvent,
  createObjective,
  createReport,
  createStatus,
  db,
  deleteSession,
  deleteStatus,
  drainOutbox,
  getBoard,
  getReport,
  listEvents,
  listReports,
  moveStatus,
  searchAll,
  setSessionStatus,
  updateObjective,
  updateStatus,
  upsertSession,
} from "./db.ts";
import { syncOnce, testRemote } from "./sync.ts";
import { startRealtime } from "./realtime.ts";
import { getIdentity, updateUserProfile } from "./identity.ts";
import {
  importClaudeSessions,
  scanClaudeSessions,
  setClaudeIgnored,
  setSessionIgnored,
} from "./claude-import.ts";
import { applyUpdate, checkUpdate, VERSION } from "./update.ts";
import {
  attachUdbToPage,
  createComment,
  createLink,
  createPage,
  deleteComment,
  deletePage,
  getPage,
  listCommentInbox,
  listComments,
  listLinks,
  listPages,
  listShares,
  listUsers,
  movePage,
  revokeLink,
  revokeShare,
  setCommentAgentStatus,
  setShare,
  updateComment,
  updatePage,
} from "./pages.ts";
import { exportPage, importPage } from "./share.ts";
import { agentIdentity } from "./agent-comments.ts";
import { listPresence, touchPresence } from "./presence.ts";
import {
  createProperty,
  createRow,
  createUdb,
  deleteProperty,
  deleteRow,
  deleteUdb,
  getUdb,
  listIcons,
  listUdbs,
  patchRow,
  setLink,
  updateProperty,
  updateUdb,
} from "./udb.ts";

const DESKTOP = Deno.env.get("TRACKER_DESKTOP") === "1";

// Native file picker for the desktop webview (it can't show <input type=file> dialogs,
// same as window.open — see /api/open). Returns the image as a data URI.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
async function pickImage(): Promise<
  { dataUri: string } | { error: string; cancelled?: boolean }
> {
  const dialogs: string[][] = Deno.build.os === "darwin"
    ? [[
      "osascript",
      "-e",
      'POSIX path of (choose file with prompt "Choose an icon" of type {"public.image"})',
    ]]
    : [
      [
        "zenity",
        "--file-selection",
        "--title=Choose an icon",
        "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.svg",
      ],
      ["kdialog", "--getopenfilename", ".", "image/*"],
    ];
  for (const [cmd, ...args] of dialogs) {
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "null",
      }).output();
    } catch {
      continue; // dialog tool not installed — try the next one
    }
    if (!out.success) return { error: "cancelled", cancelled: true };
    const path = new TextDecoder().decode(out.stdout).trim();
    if (!path) return { error: "cancelled", cancelled: true };
    let data: Uint8Array;
    try {
      data = await Deno.readFile(path);
    } catch {
      return { error: `cannot read ${path}` };
    }
    if (data.length > 10_000_000) {
      return { error: "file too large (max 10 MB)" };
    }
    const ext = path.toLowerCase().split(".").pop() ?? "";
    const mime = IMAGE_MIME[ext];
    if (!mime) return { error: `not an image: .${ext}` };
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) {
      bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    return { dataUri: `data:${mime};base64,${btoa(bin)}` };
  }
  return { error: "no file dialog available (install zenity or kdialog)" };
}

// Native save/open dialogs for the page-share bundle (same reason pickImage exists:
// the desktop webview shows no <input type=file> or download prompt). Returns the
// chosen path, or a {cancelled}/{error} sentinel.
type PickResult = string | { cancelled: true } | { error: string };
async function runDialog(dialogs: string[][]): Promise<PickResult> {
  for (const [cmd, ...args] of dialogs) {
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "null",
      }).output();
    } catch {
      continue; // dialog tool not installed — try the next one
    }
    if (!out.success) return { cancelled: true };
    const path = new TextDecoder().decode(out.stdout).trim();
    return path ? path : { cancelled: true };
  }
  return { error: "no file dialog available (install zenity or kdialog)" };
}

function pickSavePath(defaultName: string): Promise<PickResult> {
  const home = Deno.env.get("HOME") ?? ".";
  return runDialog(
    Deno.build.os === "darwin"
      ? [[
        "osascript",
        "-e",
        `POSIX path of (choose file name with prompt "Export page" default name "${defaultName}")`,
      ]]
      : [
        [
          "zenity",
          "--file-selection",
          "--save",
          "--confirm-overwrite",
          "--title=Export page",
          `--filename=${home}/${defaultName}`,
        ],
        ["kdialog", "--getsavefilename", `${home}/${defaultName}`, "*.json"],
      ],
  );
}

function pickOpenPath(): Promise<PickResult> {
  return runDialog(
    Deno.build.os === "darwin"
      ? [[
        "osascript",
        "-e",
        'POSIX path of (choose file with prompt "Import page" of type {"json","public.json"})',
      ]]
      : [
        [
          "zenity",
          "--file-selection",
          "--title=Import page",
          "--file-filter=Trame page | *.json",
        ],
        ["kdialog", "--getopenfilename", ".", "*.json"],
      ],
  );
}

let lastSync: { at: string; pulled: number; pushed: number } | null = null;
async function runSync() {
  const r = await syncOnce();
  if (r) lastSync = { at: new Date().toISOString(), ...r };
  return r;
}

// Background sync passes shouldn't dump a stack trace every time the hub is
// simply off-LAN — that's routine, not a bug. Anything else still logs in full.
const HUB_UNREACHABLE =
  /no route to host|ehostunreach|enetunreach|econnrefused|etimedout|client error \(connect\)/i;
function logSyncFailure(e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  if (HUB_UNREACHABLE.test(msg)) {
    console.warn(`sync: hub unreachable (${msg.split("\n")[0]})`);
  } else {
    console.error(e);
  }
}

// Push local writes soon after they happen instead of waiting out the poll — the
// receiving side is already realtime (WS nudges), this closes the sending side.
// Debounced so a burst of edits rides one pass.
let syncSoonTimer: ReturnType<typeof setTimeout> | undefined;
function syncSoon() {
  clearTimeout(syncSoonTimer);
  syncSoonTimer = setTimeout(() => runSync().catch(logSyncFailure), 1_500);
}

const WEB_DIST = `${APP_ROOT}/web/dist`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Run qdbus (Qt6 preferred), returning both streams so callers can inspect errors.
async function qdbusRaw(
  args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  for (const bin of ["qdbus6", "qdbus"]) {
    try {
      const r = await new Deno.Command(bin, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        ok: r.success,
        out: dec.decode(r.stdout).trim(),
        err: dec.decode(r.stderr).trim(),
      };
    } catch { /* binary missing — try the next */ }
  }
  return { ok: false, out: "", err: "qdbus not found" };
}
async function qdbus(...args: string[]): Promise<string | null> {
  const r = await qdbusRaw(args);
  return r.ok ? r.out : null;
}

// Pick the konsole window to type into: the sole one if there's only one; otherwise the
// focused window, or (when focus is on the browser) the newest by pid. null if none open.
async function activeKonsoleService(): Promise<string | null> {
  const list = await qdbus();
  if (list === null) return null;
  const svcs = list.split("\n").map((s) => s.trim()).filter((s) =>
    s.startsWith("org.kde.konsole-")
  );
  if (svcs.length <= 1) return svcs[0] ?? null;
  for (const s of svcs) {
    const active = await qdbus(
      s,
      "/konsole/MainWindow_1",
      "org.qtproject.Qt.QWidget.isActiveWindow",
    );
    if (active === "true") return s;
  }
  const pid = (s: string) => Number(s.slice("org.kde.konsole-".length)) || 0;
  return [...svcs].sort((a, b) => pid(b) - pid(a))[0];
}

// Type `command` into an already-open konsole session via D-Bus (interrupts whatever's
// there). `api-disabled` means konsole's security-sensitive D-Bus API is off — the user
// must enable it in Settings (EnableSecuritySensitiveDBusAPI); `no-konsole` means no
// reachable konsole/qdbus, so the caller falls back to copying the command.
type ExistingResult = { ok: boolean; reason?: "no-konsole" | "api-disabled" };
async function resumeInExisting(
  cwd: string,
  command: string,
): Promise<ExistingResult> {
  const svc = await activeKonsoleService();
  if (!svc) return { ok: false, reason: "no-konsole" };
  const session = await qdbus(
    svc,
    "/Windows/1",
    "org.kde.konsole.Window.currentSession",
  );
  if (!session) return { ok: false, reason: "no-konsole" };
  const r = await qdbusRaw([
    svc,
    `/Sessions/${session}`,
    "org.kde.konsole.Session.sendText",
    `cd ${shq(cwd)} && ${command}\n`,
  ]);
  if (r.ok) return { ok: true };
  const disabled = /disabled in the settings|AccessDenied/i.test(r.err);
  return { ok: false, reason: disabled ? "api-disabled" : "no-konsole" };
}

// Open a new tab in the active konsole window (D-Bus) and run `command` in it.
// `konsole --new-tab` can't attach when instances run per-process (org.kde.konsole-<pid>
// services), so a plain spawn opens a fresh window — this is the path that actually tabs.
async function tabInExisting(
  cwd: string,
  command: string,
): Promise<ExistingResult> {
  const svc = await activeKonsoleService();
  if (!svc) return { ok: false, reason: "no-konsole" };
  const sid = await qdbus(
    svc,
    "/Windows/1",
    "org.kde.konsole.Window.newSession",
  );
  if (!sid) return { ok: false, reason: "no-konsole" };
  const r = await qdbusRaw([
    svc,
    `/Sessions/${sid}`,
    "org.kde.konsole.Session.sendText",
    `cd ${shq(cwd)} && ${command}\n`,
  ]);
  if (r.ok) return { ok: true };
  const disabled = /disabled in the settings|AccessDenied/i.test(r.err);
  return { ok: false, reason: disabled ? "api-disabled" : "no-konsole" };
}

// Is this session's transcript on THIS machine? `claude --resume` only finds a session
// whose ~/.claude/projects/<dir>/<id>.jsonl lives locally, so resume is device-bound.
async function claudeTranscriptIsLocal(id: string): Promise<boolean> {
  try {
    for await (const proj of Deno.readDir(CLAUDE_DIR)) {
      if (!proj.isDirectory) continue;
      try {
        await Deno.stat(`${CLAUDE_DIR}/${proj.name}/${id}.jsonl`);
        return true;
      } catch { /* not in this project dir — keep looking */ }
    }
  } catch { /* no ~/.claude/projects here */ }
  return false;
}

async function codexTranscriptIsLocal(
  id: string,
  dir = CODEX_DIR,
  depth = 0,
): Promise<boolean> {
  if (depth > 4) return false;
  try {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isFile && e.name.endsWith(`${id}.jsonl`)) return true;
      if (e.isDirectory && await codexTranscriptIsLocal(id, path, depth + 1)) {
        return true;
      }
    }
  } catch { /* Codex not installed / unreadable directory */ }
  return false;
}

// Best-effort PR/MR state. GitHub via the authed `gh` CLI; other hosts → "unknown"
// (GitLab would need a token). Cached 60s so opening a drawer doesn't hammer the API.
const prStateCache = new Map<string, { state: string; at: number }>();
async function prState(url: string): Promise<string> {
  const hit = prStateCache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.state;
  let state = "unknown";
  try {
    if (/^https:\/\/github\.com\//.test(url)) {
      const out = await new Deno.Command("gh", {
        args: ["pr", "view", url, "--json", "state,isDraft"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (out.success) {
        const j = JSON.parse(new TextDecoder().decode(out.stdout)) as {
          state: string;
          isDraft: boolean;
        };
        state = j.state === "MERGED"
          ? "merged"
          : j.state === "CLOSED"
          ? "closed"
          : j.isDraft
          ? "draft"
          : "open";
      }
    }
  } catch { /* gh missing / offline → unknown */ }
  prStateCache.set(url, { state, at: Date.now() });
  return state;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

async function serveStatic(pathname: string): Promise<Response> {
  const p = pathname === "/" ? "index.html" : pathname.slice(1);
  const type = p.endsWith(".js")
    ? "text/javascript"
    : p.endsWith(".css")
    ? "text/css"
    : p.endsWith(".html")
    ? "text/html"
    : "application/octet-stream";
  const headers = {
    "content-type": type,
    // hashed assets are immutable; everything else must revalidate so a rebuild is picked up on reload
    "cache-control": p.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  try {
    // dev: read from disk so `just web-build` refreshes live
    const body = await Deno.readFile(`${WEB_DIST}/${p}`);
    return new Response(body, { headers });
  } catch {
    // bundled installs: assets embedded in the compile VFS
    const embedded = ASSETS[p];
    if (embedded) return new Response(new Uint8Array(embedded), { headers });
    // a missing asset must 404 — an HTML body here makes dynamic import() fail with a MIME error
    if (p.startsWith("assets/")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<h1>🧵 Trame</h1><p>Frontend not built — run <code>just web-build</code>.</p>`,
      { headers: { "content-type": "text/html" } },
    );
  }
}

let boundPort = PORT; // set to the real port after serve (random in desktop mode)

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// Standalone editor for a .excalidraw scene — for "open in browser", where scripts
// run (the in-app preview pre-renders static SVG instead; see web/src/excalidraw.ts).
// Edits auto-save back to the file via POST /report-file.
function excalidrawPage(json: string, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css">
<body style="margin:0">
<div id="root" style="position:fixed;inset:0"></div>
<div id="status" style="position:fixed;right:14px;bottom:14px;z-index:10;font:12px system-ui;color:#555;background:#fffc;border-radius:6px;padding:2px 8px;pointer-events:none"></div>
<script type="application/json" id="scene">${
    json.replaceAll("</", "<\\/")
  }</script>
<script type="module">
globalThis.EXCALIDRAW_ASSET_PATH ??= "https://unpkg.com/@excalidraw/excalidraw@0.18.1/dist/prod/";
import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
const { Excalidraw, serializeAsJSON } = await import("https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@18.3.1,react-dom@18.3.1");
const scene = JSON.parse(document.getElementById("scene").textContent);
delete scene.appState?.collaborators; // serialized maps break restore
const status = document.getElementById("status");
let api, timer, lastSaved = null;
async function save() {
  if (!api) return;
  const body = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
  if (body === lastSaved) return;
  status.textContent = "saving…";
  const r = await fetch(location.href, { method: "POST", body }).catch(() => null);
  status.textContent = r && r.ok ? "saved" : "⚠ save failed";
  if (r && r.ok) lastSaved = body;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
createRoot(document.getElementById("root")).render(React.createElement(Excalidraw, {
  initialData: scene,
  excalidrawAPI: (a) => { api = a; },
  onChange: () => { clearTimeout(timer); timer = setTimeout(save, 800); },
}));
</script></body>`;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // CSRF: /api spawns terminals, opens files and approves deployments — a foreign page
  // can't read the response but the side effect would still fire.
  if (pathname.startsWith("/api/") && isCrossSite(req)) {
    return json({ error: "cross-origin request blocked" }, 403);
  }

  // Raw report pages — targets for "open in system browser".
  const rawDb = pathname.match(/^\/report\/([^/]+)$/);
  if (rawDb) {
    const r = await getReport(rawDb[1]) as { html: string } | null;
    return r ? html(r.html) : html("report not found", 404);
  }
  if (pathname === "/report-file" && req.method === "POST") {
    const p = url.searchParams.get("path") ?? "";
    const body = await req.text();
    try {
      if (JSON.parse(body)?.type !== "excalidraw") {
        return json({ error: "not an excalidraw scene" }, 400);
      }
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const ok = await writeReportFile(p, body);
    return ok
      ? json({ ok: true })
      : json({ error: "not allowed or not found" }, 404);
  }
  if (pathname === "/report-file") {
    const p = url.searchParams.get("path") ?? "";
    const content = await readReportFile(p);
    if (content === null) return html("not allowed or not found", 404);
    return html(
      p.endsWith(".excalidraw") ? excalidrawPage(content, p) : content,
    );
  }
  // Open a target in the system browser (webview has no window.open).
  if (pathname === "/api/open" && req.method === "POST") {
    const { target } = await req.json();
    if (
      typeof target !== "string" ||
      !(target.startsWith("/") || /^https?:\/\//.test(target))
    ) {
      return json({ error: "invalid target" }, 400);
    }
    const full = target.startsWith("/")
      ? `http://127.0.0.1:${boundPort}${target}`
      : target;
    const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
    new Deno.Command(cmd, { args: [full], stdout: "null", stderr: "null" })
      .spawn();
    return json({ ok: true });
  }
  // Best-effort PR/MR state for a link (open|draft|merged|closed|unknown).
  if (pathname === "/api/pr-state" && req.method === "POST") {
    const { url } = await req.json();
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      return json({ error: "invalid url" }, 400);
    }
    return json({ url, state: await prState(url) });
  }
  // Resume a Claude Code or Codex session on the machine holding its transcript.
  if (pathname === "/api/resume" && req.method === "POST") {
    const { id, probe, mode, repoPath: rawRepoPath, agent: rawAgent } =
      await req
        .json();
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return json({ error: "invalid id" }, 400);
    }
    const launchMode: LaunchMode = mode === "tab" || mode === "existing"
      ? mode
      : "window";

    let repo: string | null | undefined;
    let cid: string;
    let agent: string;
    let local: boolean;
    let homeNode: string | null = null;

    if (typeof rawRepoPath === "string" && rawRepoPath) {
      // Sessions view: caller just scanned this transcript on this machine's own
      // ~/.claude (or ~/.codex) dir — no sessions-table row needed, and it's local by
      // construction. Not looked up in the DB, so this never doubles as a track action.
      repo = rawRepoPath;
      cid = id;
      agent = rawAgent === "codex" ? "codex" : "claude";
      local = true;
    } else {
      const pg = await db();
      const row = (await pg.query(
        `select repo_path, claude_id, agent from sessions where id=$1 and not deleted`,
        [id],
      ))
        .rows[0] as {
          repo_path: string | null;
          claude_id: string | null;
          agent: string | null;
        } | undefined;
      repo = row?.repo_path;
      // Imported cards carry the transcript UUID as id; skill-tracked cards store it
      // in the legacy-named claude_id column. cid flows into a shell command, so it
      // must be a UUID like id — guard against a poisoned/synced claude_id value.
      cid = row?.claude_id && UUID_RE.test(row.claude_id) ? row.claude_id : id;
      // Home device = the node that imported it (its transcript lives there).
      const ev = (await pg.query(
        `select summary from session_events where session_id=$1 and kind='import' and not deleted order by at limit 1`,
        [id],
      )).rows[0] as { summary: string | null } | undefined;
      agent =
        row?.agent === "codex" || ev?.summary?.startsWith("Imported from Codex")
          ? "codex"
          : "claude";
      // "Imported from <agent> · <node>" — only trust a node after the separator
      // (older imports had no "· <node>" suffix; splitting would echo the whole label)
      const parts = ev?.summary?.split("·") ?? [];
      homeNode = parts.length > 1
        ? parts[parts.length - 1].trim() || null
        : null;
      local = agent === "codex"
        ? await codexTranscriptIsLocal(cid)
        : await claudeTranscriptIsLocal(cid);
    }

    const cmd = agent === "codex"
      ? `codex resume ${cid}`
      : `claude --resume ${cid}`;
    const full = repo ? `cd ${shq(repo)} && ${cmd}` : cmd;
    const base = { local, homeNode, cmd: full, repo, agent };
    // probe: report resumability for the button affordance, without opening a terminal
    if (probe) {
      return json({ ...base, ok: local && Boolean(repo), launched: false });
    }
    // resume only works where the transcript lives — don't open a terminal that just errors
    if (!repo || !local) return json({ ...base, ok: false, launched: false });
    if (launchMode === "existing") {
      const r = await resumeInExisting(repo, cmd);
      return json({
        ...base,
        ok: r.ok,
        launched: r.ok,
        local: true,
        mode: launchMode,
        reason: r.reason,
      });
    }
    // tab on Linux: attach via konsole D-Bus first — spawning `konsole --new-tab`
    // opens a fresh window when instances are per-process. no-konsole falls through
    // to the spawn path (gnome-terminal --tab etc.); api-disabled reports back so
    // the UI copies the command instead of opening a stray window.
    if (launchMode === "tab" && Deno.build.os === "linux") {
      const r = await tabInExisting(repo, cmd);
      if (r.ok || r.reason === "api-disabled") {
        return json({
          ...base,
          ok: r.ok,
          launched: r.ok,
          local: true,
          mode: launchMode,
          reason: r.reason,
        });
      }
    }
    const launched = spawnTerminal(repo, cmd, launchMode);
    return json({
      ...base,
      ok: launched,
      launched,
      local: true,
      mode: launchMode,
    });
  }
  // Directory autocomplete for the Explore "report folders" field. Lists sub-directories
  // of the typed path's parent whose name prefix-matches; ~ is expanded and re-collapsed.
  if (pathname === "/api/fs/complete") {
    const home = Deno.env.get("HOME") ?? "";
    const raw = url.searchParams.get("path") ?? "";
    const abs = raw.startsWith("~") ? home + raw.slice(1) : raw;
    const slash = abs.lastIndexOf("/");
    const dir = slash < 0 ? "." : slash === 0 ? "/" : abs.slice(0, slash);
    const prefix = abs.slice(slash + 1).toLowerCase();
    const dirs: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isDirectory && !e.isSymlink) continue;
        if (e.name.startsWith(".") && !prefix.startsWith(".")) continue; // hide dotdirs unless typed
        if (!e.name.toLowerCase().startsWith(prefix)) continue;
        const full = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
        dirs.push(
          home && full.startsWith(home) ? `~${full.slice(home.length)}` : full,
        );
      }
    } catch { /* unreadable / missing dir → no suggestions */ }
    dirs.sort();
    return json({ dirs: dirs.slice(0, 24) });
  }

  if (pathname === "/api/plugins") return json(await listPluginManifests());
  if (pathname.startsWith("/api/plugins/")) return handlePluginRoute(req, url);

  if (pathname === "/api/board") return json(await getBoard());
  // Quick-find (Ctrl+P): search sessions/pages/databases; empty q = recently touched.
  if (pathname === "/api/search") {
    return json(await searchAll(url.searchParams.get("q") ?? ""));
  }
  if (pathname === "/api/status") {
    return json({
      nodeId: NODE_ID,
      remote: Boolean(await getRemotePg()),
      lastSync,
      dataDir: DATA_DIR,
      desktop: DESKTOP,
      version: VERSION,
    });
  }
  if (pathname === "/api/update" && req.method === "POST") {
    return json(await applyUpdate());
  }
  if (pathname === "/api/update") {
    // opt-out for sandboxes/CI: no surprise calls to api.github.com
    if (Deno.env.get("TRACKER_UPDATE_CHECK") === "0") {
      return json({
        current: VERSION,
        latest: null,
        available: false,
        releaseUrl: "",
        canSelfUpdate: false,
      });
    }
    return json(await checkUpdate(url.searchParams.has("force")));
  }
  if (pathname === "/api/sync" && req.method === "POST") {
    return json(await runSync());
  }
  // Probe a hub with (possibly unsaved) settings-form values — nothing is persisted.
  if (pathname === "/api/hub/test" && req.method === "POST") {
    const body = await req.json();
    const url = await resolveRemotePg(
      typeof body.remotePg === "string" ? body.remotePg : "",
      typeof body.remotePgPassword === "string" ? body.remotePgPassword : "",
    );
    return json(
      url ? await testRemote(url) : { ok: false, error: "no hub configured" },
    );
  }
  if (pathname === "/api/import/claude/ignore" && req.method === "POST") {
    const { claudeId, ignored, source } = await req.json();
    return json(
      source === "codex"
        ? await setSessionIgnored("codex", String(claudeId), Boolean(ignored))
        : await setClaudeIgnored(String(claudeId), Boolean(ignored)),
    );
  }
  if (pathname === "/api/import/claude" && req.method === "POST") {
    const body = await req.json();
    return json(
      await importClaudeSessions(Array.isArray(body.items) ? body.items : []),
    );
  }
  if (pathname === "/api/import/claude") {
    const days = Math.min(
      90,
      Math.max(1, Number(url.searchParams.get("days")) || 7),
    );
    return json(await scanClaudeSessions(days));
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await req.json();
    const id = await upsertSession(body);
    // A summary from track/MCP is a worklog entry, not just a field.
    if (
      typeof body.summary === "string" && body.summary.trim() && !body.no_event
    ) {
      await addEvent(id, body.summary, "track");
    }
    return json({ id });
  }
  const em = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (em && req.method === "POST") {
    await addEvent(em[1], (await req.json()).summary ?? "");
    return json({ ok: true });
  }
  if (em) return json(await listEvents(em[1]));
  const dm = pathname.match(/^\/api\/sessions\/([^/]+)\/delete$/);
  if (dm && req.method === "POST") {
    await deleteSession(dm[1]);
    return json({ ok: true });
  }
  if (pathname === "/api/objectives" && req.method === "POST") {
    return json({ id: await createObjective(await req.json()) });
  }
  const om = pathname.match(/^\/api\/objectives\/([^/]+)$/);
  if (om && req.method === "POST") {
    await updateObjective({ id: om[1], ...(await req.json()) });
    return json({ ok: true });
  }
  if (pathname === "/api/reports" && req.method === "POST") {
    return json({ id: await createReport(await req.json()) });
  }
  if (pathname === "/api/reports") return json(await listReports());
  if (pathname === "/api/settings" && req.method === "POST") {
    const body = await req.json();
    await saveExploreSettings({
      reportPaths: Array.isArray(body.reportPaths)
        ? body.reportPaths
        : undefined,
      ignorePaths: Array.isArray(body.ignorePaths)
        ? body.ignorePaths
        : undefined,
      starredPaths: Array.isArray(body.starredPaths)
        ? body.starredPaths
        : undefined,
      htmlFilter: body.htmlFilter === "smart" || body.htmlFilter === "all"
        ? body.htmlFilter
        : undefined,
      remotePg: typeof body.remotePg === "string" ? body.remotePg : undefined,
      remotePgPassword: typeof body.remotePgPassword === "string"
        ? body.remotePgPassword
        : undefined,
      authorName: typeof body.authorName === "string"
        ? body.authorName
        : undefined,
      authorAvatar: typeof body.authorAvatar === "string"
        ? body.authorAvatar
        : undefined,
    });
    // an explicit save also updates the synced profile (never done at startup —
    // stale local names on two machines would ping-pong the users row)
    await updateUserProfile({
      name: typeof body.authorName === "string" ? body.authorName : undefined,
      avatar: typeof body.authorAvatar === "string"
        ? body.authorAvatar
        : undefined,
    }).catch(console.error);
    return json(await getReportPaths());
  }
  if (pathname === "/api/settings") return json(await getReportPaths());
  if (pathname === "/api/report-files/delete" && req.method === "POST") {
    const res = await deleteReportFile((await req.json()).path ?? "");
    return res.ok
      ? json(res)
      : json({ error: "not allowed or not found" }, 404);
  }
  if (pathname === "/api/report-files") {
    return json(await scanReportFiles(url.searchParams.has("force")));
  }
  if (pathname === "/api/report-files/content") {
    const p = url.searchParams.get("path") ?? "";
    const html = await readReportFile(p);
    return html === null
      ? json({ error: "not allowed or not found" }, 404)
      : json({ path: p, html });
  }
  // Live directory listing + OS-open for the "folder" page block.
  if (pathname === "/api/folder") {
    const p = url.searchParams.get("path") ?? "";
    const entries = await listFolder(p);
    return entries === null
      ? json({ error: "not allowed or not found" }, 404)
      : json({ path: p, entries });
  }
  if (pathname === "/api/open-path" && req.method === "POST") {
    const { path } = await req.json().catch(() => ({}));
    const real = typeof path === "string"
      ? await resolveAllowedPath(path)
      : null;
    if (real === null) return json({ error: "not allowed or not found" }, 404);
    const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
    new Deno.Command(cmd, { args: [real], stdout: "null", stderr: "null" })
      .spawn();
    return json({ ok: true });
  }
  const rm = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (rm) {
    const report = await getReport(rm[1]);
    return report ? json(report) : json({ error: "not found" }, 404);
  }
  const m = pathname.match(/^\/api\/sessions\/([^/]+)\/status$/);
  if (m && req.method === "POST") {
    await setSessionStatus(m[1], (await req.json()).status);
    return json({ ok: true });
  }

  // statuses — the kanban columns (add/rename/recolor/reorder/delete)
  if (pathname === "/api/statuses" && req.method === "POST") {
    const b = await req.json();
    return json({
      id: await createStatus({
        label: b.label,
        color: b.color,
        terminal: b.terminal,
      }),
    });
  }
  const stm = pathname.match(/^\/api\/statuses\/([^/]+)(\/delete|\/move)?$/);
  if (stm && req.method === "POST") {
    try {
      if (stm[2] === "/delete") await deleteStatus(stm[1]);
      else if (stm[2] === "/move") {
        await moveStatus(stm[1], (await req.json()).dir === -1 ? -1 : 1);
      } else await updateStatus(stm[1], await req.json());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    return json({ ok: true });
  }

  // inline page comments (block-level notes)
  if (pathname === "/api/comments" && req.method === "POST") {
    return json({ id: await createComment(await req.json()) });
  }
  if (pathname === "/api/comments/inbox") {
    const stale = Number(url.searchParams.get("stale") ?? "600");
    return json(await listCommentInbox(Number.isFinite(stale) ? stale : 600));
  }
  if (pathname === "/api/comments") {
    const pageId = url.searchParams.get("page");
    return json(pageId ? await listComments(pageId) : []);
  }
  const cmtStatus = pathname.match(/^\/api\/comments\/([^/]+)\/agent-status$/);
  if (cmtStatus && req.method === "POST") {
    const body = await req.json();
    // enum-indexed badge in the UI crashes on an unknown status — reject up front
    const STATUSES = ["seen", "answering", "failed", "answered", "clear"];
    if (!STATUSES.includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    await setCommentAgentStatus(cmtStatus[1], body);
    return json({ ok: true });
  }
  const cmt = pathname.match(/^\/api\/comments\/([^/]+)(\/delete)?$/);
  if (cmt && req.method === "POST") {
    if (cmt[2]) await deleteComment(cmt[1]);
    else await updateComment(cmt[1], await req.json());
    return json({ ok: true });
  }

  // who am I — lets the UI gate comment editing to the local author
  if (pathname === "/api/identity") return json(await getIdentity());

  // ephemeral presence (device-local, not synced): who's on a page + active watchers
  if (pathname === "/api/presence" && req.method === "POST") {
    const b = await req.json();
    if (b.watcher === "codex" || b.watcher === "claude") {
      const a = agentIdentity(b.watcher);
      touchPresence({
        id: `watcher:${b.watcher}`,
        kind: "watcher",
        name: a.name,
        avatar: a.avatar,
        page_id: "*",
      });
    } else {
      const me = await getIdentity();
      const page = String(b.page_id ?? "");
      touchPresence({
        // key by user AND page so the same user in two tabs on different pages
        // gets one entry each instead of flapping over a single user-keyed row
        id: `${me.userId ?? `dev:${NODE_ID}`}:${page}`,
        kind: "viewer",
        name: me.name,
        avatar: me.avatar,
        page_id: page,
      });
    }
    return json({ ok: true });
  }
  if (pathname === "/api/presence") {
    return json(listPresence(url.searchParams.get("page") ?? ""));
  }

  // sharing (phase 7): grants live in page_shares and ride the normal sync
  if (pathname === "/api/users") return json(await listUsers());
  if (pathname === "/api/shares" && req.method === "POST") {
    return json({ id: await setShare(await req.json()) });
  }
  if (pathname === "/api/shares") {
    const pageId = url.searchParams.get("page");
    return json(pageId ? await listShares(pageId) : []);
  }
  const shr = pathname.match(/^\/api\/shares\/([^/]+)\/delete$/);
  if (shr && req.method === "POST") {
    await revokeShare(shr[1]);
    return json({ ok: true });
  }
  if (pathname === "/api/links" && req.method === "POST") {
    const body = await req.json();
    const { id, token } = await createLink(String(body.page_id));
    const base = await getLinkBase();
    return json({ id, url: base ? `${base}/l/${token}` : null, token });
  }
  if (pathname === "/api/links") {
    const pageId = url.searchParams.get("page");
    return json({
      base: await getLinkBase(),
      links: pageId ? await listLinks(pageId) : [],
    });
  }
  const lnk = pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
  if (lnk && req.method === "POST") {
    await revokeLink(lnk[1]);
    return json({ ok: true });
  }

  // pages — the nestable tree; project pages also serve /api/objectives above
  if (pathname === "/api/pages" && req.method === "POST") {
    return json({ id: await createPage(await req.json()) });
  }
  if (pathname === "/api/pages") return json(await listPages());
  // Share: export a page subtree to a portable bundle file another Trame user can import.
  if (pathname === "/api/pages/import" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as {
      parent_id?: string | null;
    };
    const picked = await pickOpenPath();
    if (typeof picked !== "string") return json(picked);
    let bundle: unknown;
    try {
      bundle = JSON.parse(await Deno.readTextFile(picked));
    } catch {
      return json({ error: "cannot read file" }, 400);
    }
    try {
      return json({ id: await importPage(bundle, body.parent_id ?? null) });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  const pgexp = pathname.match(/^\/api\/pages\/([^/]+)\/export$/);
  if (pgexp && req.method === "POST") {
    const bundle = await exportPage(pgexp[1]);
    if (!bundle) return json({ error: "page not found" }, 404);
    const title = bundle.pages.find((p) =>
      p.id === bundle.root
    )?.title?.trim() || "page";
    const safe =
      title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
      "page";
    const picked = await pickSavePath(`${safe}.trame.json`);
    if (typeof picked !== "string") return json(picked);
    const dest = picked.endsWith(".json") ? picked : `${picked}.json`;
    await Deno.writeTextFile(dest, JSON.stringify(bundle, null, 2));
    return json({ path: dest });
  }
  const pgm = pathname.match(/^\/api\/pages\/([^/]+)(\/delete|\/move)?$/);
  if (pgm && req.method === "POST") {
    try {
      if (pgm[2] === "/delete") await deletePage(pgm[1]);
      else if (pgm[2] === "/move") await movePage(pgm[1], await req.json());
      else await updatePage(pgm[1], await req.json());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    return json({ ok: true });
  }
  if (pgm && !pgm[2]) {
    const page = await getPage(pgm[1]);
    return page ? json(page) : json({ error: "not found" }, 404);
  }

  // user-defined databases — specific routes before the /api/udb/:id catch-all
  if (pathname === "/api/udb" && req.method === "POST") {
    return json({ id: await createUdb((await req.json()).name ?? "Untitled") });
  }
  if (pathname === "/api/udb") return json(await listUdbs());
  if (pathname === "/api/udb/icons") return json(await listIcons());
  if (pathname === "/api/pick-image" && req.method === "POST") {
    return json(await pickImage());
  }
  if (pathname === "/api/udb/links" && req.method === "POST") {
    const b = await req.json();
    await setLink(b.prop_id, b.from_row, b.to_row, Boolean(b.remove));
    return json({ ok: true });
  }
  const upd = pathname.match(/^\/api\/udb\/props\/([^/]+)(\/delete)?$/);
  if (upd && req.method === "POST") {
    if (upd[2]) await deleteProperty(upd[1]);
    else {
      try {
        await updateProperty(upd[1], await req.json());
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    return json({ ok: true });
  }
  const urw = pathname.match(/^\/api\/udb\/rows\/([^/]+)(\/delete)?$/);
  if (urw && req.method === "POST") {
    if (urw[2]) await deleteRow(urw[1]);
    else {
      const b = await req.json();
      await patchRow(urw[1], b.vals ?? {}, "icon" in b ? b.icon : undefined);
    }
    return json({ ok: true });
  }
  const usub = pathname.match(/^\/api\/udb\/([^/]+)\/(props|rows|delete)$/);
  if (usub && req.method === "POST") {
    if (usub[2] === "delete") {
      await deleteUdb(usub[1]);
      return json({ ok: true });
    }
    if (usub[2] === "props") {
      try {
        return json({ id: await createProperty(usub[1], await req.json()) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    const rb = await req.json();
    return json({ id: await createRow(usub[1], rb.vals, rb.icon ?? null) });
  }
  const udm = pathname.match(/^\/api\/udb\/([^/]+)$/);
  if (udm && req.method === "POST") {
    const b = await req.json();
    if ("page_id" in b) await attachUdbToPage(udm[1], b.page_id);
    await updateUdb(udm[1], b);
    return json({ ok: true });
  }
  if (udm) {
    const data = await getUdb(udm[1]);
    return data ? json(data) : json({ error: "not found" }, 404);
  }
  if (!pathname.startsWith("/api/")) return serveStatic(pathname);
  return json({ error: "not found" }, 404);
}

// Single-instance guard: PGlite is single-process — if another live instance holds the
// data dir, exit with a pointer instead of aborting deep inside WASM initdb.
try {
  const { port, pid } = JSON.parse(await Deno.readTextFile(PORT_FILE));
  if (pid !== Deno.pid) {
    const alive = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(800),
    }).then((r) => r.ok).catch(() => false);
    if (alive) {
      console.error(
        `Another Trame instance is already running on :${port} (pid ${pid}) — exiting.`,
      );
      Deno.exit(1);
    }
  }
} catch { /* no port file — fine */ }

// Startup: pick up any offline CLI writes, sync once, then poll. The device→user
// claim happens inside db() init (kept lazy — e2e wipes the data dir post-listen).
await drainOutbox();
runSync().catch(logSyncFailure);
setInterval(() => runSync().catch(logSyncFailure), SYNC_INTERVAL_MS);
// hub WS nudges (when syncViaApi is on): a nudge just runs the same sync early —
// the poll above stays as the fallback when the socket is down
startRealtime(() => runSync().catch(logSyncFailure));
startPlugins();

// Every successful mutating /api call schedules a debounced push (excluding /api/sync
// itself — it IS the sync — and /api/presence, which writes only ephemeral in-memory
// state and would otherwise sync on every heartbeat). GETs and failures don't.
async function serveHandler(req: Request): Promise<Response> {
  const res = await handler(req);
  const p = new URL(req.url).pathname;
  if (
    req.method !== "GET" && res.ok &&
    p.startsWith("/api/") &&
    !p.startsWith("/api/sync") && !p.startsWith("/api/presence")
  ) {
    syncSoon();
  }
  return res;
}

// Under `deno desktop` (TRACKER_DESKTOP=1) don't pin a port — the framework binds the
// address the webview navigates to. Headless `serve` uses a fixed port so the browser
// and the vite dev proxy know where to reach the API.
let server: Deno.HttpServer<Deno.NetAddr>;
if (Deno.env.get("TRACKER_DESKTOP") === "1") {
  console.log(`🧵 Trame (desktop)  local db: ${DATA_DIR}`);
  server = Deno.serve(serveHandler);
} else {
  console.log(`🧵 Trame → http://localhost:${PORT}  (local db: ${DATA_DIR})`);
  server = Deno.serve({ port: PORT, hostname: HOST }, serveHandler);
}

boundPort = server.addr.port;

// Publish the bound port so the CLI / MCP server can find this instance.
await Deno.mkdir(PORT_FILE.replace(/\/[^/]+$/, ""), { recursive: true }).catch(
  () => {},
);
await Deno.writeTextFile(
  PORT_FILE,
  JSON.stringify({
    port: server.addr.port,
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
  }),
);

if (REPORT_PATHS.length) {
  console.log(`✦ Explore scans: ${REPORT_PATHS.join(" · ")}`);
}

// Desktop window: adopt the auto-opened window, restore saved geometry, persist on change.
// deno-lint-ignore no-explicit-any
const BW = (Deno as any).BrowserWindow;
if (Deno.env.get("TRACKER_DESKTOP") === "1" && BW) {
  let geo: { width?: number; height?: number; x?: number; y?: number } = {};
  try {
    geo = JSON.parse(await Deno.readTextFile(WINDOW_FILE));
  } catch { /* first run */ }
  const win = new BW({
    title: "Trame",
    width: geo.width ?? 1360,
    height: geo.height ?? 880,
    x: geo.x,
    y: geo.y,
  });
  // ctor opts may not apply when adopting — enforce explicitly
  if (geo.width && geo.height) win.setSize(geo.width, geo.height);
  else win.setSize(1360, 880);
  if (geo.x != null && geo.y != null) win.setPosition(geo.x, geo.y);
  win.setTitle("Trame");
  // macOS/GTK reset the title to the binary name (Trame.dylib / trame.so) at
  // unpredictable points after webview init — keep re-applying, it's cheap
  setInterval(() => {
    try {
      win.setTitle("Trame");
    } catch { /* window gone */ }
  }, 1500);
  let t: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const [width, height] = win.getSize();
        const [x, y] = win.getPosition();
        await Deno.writeTextFile(
          WINDOW_FILE,
          JSON.stringify({ width, height, x, y }),
        );
      } catch { /* window gone */ }
    }, 400);
  };
  win.addEventListener("resize", persist);
  win.addEventListener("move", persist);
}
