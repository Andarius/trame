// Deno-desktop entrypoint. `deno desktop main.ts` (Deno 2.9+) opens a native window
// pointed at this in-process HTTP server. `deno task serve` runs it headless (open in a
// browser) if you don't have the desktop subcommand yet.
import {
  APP_ROOT,
  DATA_DIR,
  NODE_ID,
  PORT,
  PORT_FILE,
  REMOTE_PG,
  REPORT_PATHS,
  SYNC_INTERVAL_MS,
  WINDOW_FILE,
} from "./config.ts";
import { deleteReportFile, getReportPaths, readReportFile, saveExploreSettings, scanReportFiles } from "./files.ts";
import { ASSETS } from "./embed.ts";
import {
  addEvent,
  createObjective,
  createReport,
  deleteSession,
  drainOutbox,
  getBoard,
  getReport,
  listEvents,
  listReports,
  setSessionStatus,
  updateObjective,
  upsertSession,
} from "./db.ts";
import { syncOnce } from "./sync.ts";
import { importClaudeSessions, scanClaudeSessions } from "./claude-import.ts";
import { applyUpdate, checkUpdate, VERSION } from "./update.ts";
import { attachUdbToPage, createPage, deletePage, getPage, listPages, movePage, updatePage } from "./pages.ts";
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
async function pickImage(): Promise<{ dataUri: string } | { error: string; cancelled?: boolean }> {
  const dialogs: string[][] = Deno.build.os === "darwin"
    ? [["osascript", "-e", 'POSIX path of (choose file with prompt "Choose an icon" of type {"public.image"})']]
    : [
      ["zenity", "--file-selection", "--title=Choose an icon", "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.svg"],
      ["kdialog", "--getopenfilename", ".", "image/*"],
    ];
  for (const [cmd, ...args] of dialogs) {
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
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
    if (data.length > 10_000_000) return { error: "file too large (max 10 MB)" };
    const ext = path.toLowerCase().split(".").pop() ?? "";
    const mime = IMAGE_MIME[ext];
    if (!mime) return { error: `not an image: .${ext}` };
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { dataUri: `data:${mime};base64,${btoa(bin)}` };
  }
  return { error: "no file dialog available (install zenity or kdialog)" };
}

let lastSync: { at: string; pulled: number; pushed: number } | null = null;
async function runSync() {
  const r = await syncOnce();
  if (r) lastSync = { at: new Date().toISOString(), ...r };
  return r;
}

const WEB_DIST = `${APP_ROOT}/web/dist`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function serveStatic(pathname: string): Promise<Response> {
  const p = pathname === "/" ? "index.html" : pathname.slice(1);
  const type = p.endsWith(".js") ? "text/javascript"
    : p.endsWith(".css") ? "text/css"
    : p.endsWith(".html") ? "text/html"
    : "application/octet-stream";
  try {
    // dev: read from disk so `just web-build` refreshes live
    const body = await Deno.readFile(`${WEB_DIST}/${p}`);
    return new Response(body, { headers: { "content-type": type } });
  } catch {
    // bundled installs: assets embedded in the compile VFS
    const embedded = ASSETS[p];
    if (embedded) return new Response(new Uint8Array(embedded), { headers: { "content-type": type } });
    return new Response(
      `<h1>🧵 Trame</h1><p>Frontend not built — run <code>just web-build</code>.</p>`,
      { headers: { "content-type": "text/html" } },
    );
  }
}

let boundPort = PORT; // set to the real port after serve (random in desktop mode)

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // Raw report pages — targets for "open in system browser".
  const rawDb = pathname.match(/^\/report\/([^/]+)$/);
  if (rawDb) {
    const r = await getReport(rawDb[1]) as { html: string } | null;
    return r ? html(r.html) : html("report not found", 404);
  }
  if (pathname === "/report-file") {
    const content = await readReportFile(url.searchParams.get("path") ?? "");
    return content === null ? html("not allowed or not found", 404) : html(content);
  }
  // Open a target in the system browser (webview has no window.open).
  if (pathname === "/api/open" && req.method === "POST") {
    const { target } = await req.json();
    if (typeof target !== "string" || !(target.startsWith("/") || /^https?:\/\//.test(target))) {
      return json({ error: "invalid target" }, 400);
    }
    const full = target.startsWith("/") ? `http://127.0.0.1:${boundPort}${target}` : target;
    const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
    new Deno.Command(cmd, { args: [full], stdout: "null", stderr: "null" }).spawn();
    return json({ ok: true });
  }

  if (pathname === "/api/board") return json(await getBoard());
  if (pathname === "/api/status") {
    return json({ nodeId: NODE_ID, remote: Boolean(REMOTE_PG), lastSync, dataDir: DATA_DIR, desktop: DESKTOP, version: VERSION });
  }
  if (pathname === "/api/update" && req.method === "POST") return json(await applyUpdate());
  if (pathname === "/api/update") {
    // opt-out for sandboxes/CI: no surprise calls to api.github.com
    if (Deno.env.get("TRACKER_UPDATE_CHECK") === "0") {
      return json({ current: VERSION, latest: null, available: false, releaseUrl: "", canSelfUpdate: false });
    }
    return json(await checkUpdate(url.searchParams.has("force")));
  }
  if (pathname === "/api/sync" && req.method === "POST") return json(await runSync());
  if (pathname === "/api/import/claude" && req.method === "POST") {
    const body = await req.json();
    return json(await importClaudeSessions(Array.isArray(body.items) ? body.items : []));
  }
  if (pathname === "/api/import/claude") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
    return json(await scanClaudeSessions(days));
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await req.json();
    const id = await upsertSession(body);
    // A summary from track/MCP is a worklog entry, not just a field.
    if (typeof body.summary === "string" && body.summary.trim() && !body.no_event) {
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
      reportPaths: Array.isArray(body.reportPaths) ? body.reportPaths : undefined,
      ignorePaths: Array.isArray(body.ignorePaths) ? body.ignorePaths : undefined,
      starredPaths: Array.isArray(body.starredPaths) ? body.starredPaths : undefined,
      htmlFilter: body.htmlFilter === "smart" || body.htmlFilter === "all" ? body.htmlFilter : undefined,
    });
    return json(await getReportPaths());
  }
  if (pathname === "/api/settings") return json(await getReportPaths());
  if (pathname === "/api/report-files/delete" && req.method === "POST") {
    const res = await deleteReportFile((await req.json()).path ?? "");
    return res.ok ? json(res) : json({ error: "not allowed or not found" }, 404);
  }
  if (pathname === "/api/report-files") return json(await scanReportFiles(url.searchParams.has("force")));
  if (pathname === "/api/report-files/content") {
    const p = url.searchParams.get("path") ?? "";
    const html = await readReportFile(p);
    return html === null ? json({ error: "not allowed or not found" }, 404) : json({ path: p, html });
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

  // pages — the nestable tree; project pages also serve /api/objectives above
  if (pathname === "/api/pages" && req.method === "POST") {
    return json({ id: await createPage(await req.json()) });
  }
  if (pathname === "/api/pages") return json(await listPages());
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
  if (pathname === "/api/pick-image" && req.method === "POST") return json(await pickImage());
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
      console.error(`Another Trame instance is already running on :${port} (pid ${pid}) — exiting.`);
      Deno.exit(1);
    }
  }
} catch { /* no port file — fine */ }

// Startup: pick up any offline CLI writes, sync once, then poll.
await drainOutbox();
runSync().catch(console.error);
setInterval(() => runSync().catch(console.error), SYNC_INTERVAL_MS);

// Under `deno desktop` (TRACKER_DESKTOP=1) don't pin a port — the framework binds the
// address the webview navigates to. Headless `serve` uses a fixed port so the browser
// and the vite dev proxy know where to reach the API.
let server: Deno.HttpServer<Deno.NetAddr>;
if (Deno.env.get("TRACKER_DESKTOP") === "1") {
  console.log(`🧵 Trame (desktop)  local db: ${DATA_DIR}`);
  server = Deno.serve(handler);
} else {
  console.log(`🧵 Trame → http://localhost:${PORT}  (local db: ${DATA_DIR})`);
  server = Deno.serve({ port: PORT }, handler);
}

boundPort = server.addr.port;

// Publish the bound port so the CLI / MCP server can find this instance.
await Deno.mkdir(PORT_FILE.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
await Deno.writeTextFile(
  PORT_FILE,
  JSON.stringify({ port: server.addr.port, pid: Deno.pid, startedAt: new Date().toISOString() }),
);

if (REPORT_PATHS.length) console.log(`✦ Explore scans: ${REPORT_PATHS.join(" · ")}`);

// Desktop window: adopt the auto-opened window, restore saved geometry, persist on change.
// deno-lint-ignore no-explicit-any
const BW = (Deno as any).BrowserWindow;
if (Deno.env.get("TRACKER_DESKTOP") === "1" && BW) {
  let geo: { width?: number; height?: number; x?: number; y?: number } = {};
  try {
    geo = JSON.parse(await Deno.readTextFile(WINDOW_FILE));
  } catch { /* first run */ }
  const win = new BW({ title: "Trame", width: geo.width ?? 1360, height: geo.height ?? 880, x: geo.x, y: geo.y });
  // ctor opts may not apply when adopting — enforce explicitly
  if (geo.width && geo.height) win.setSize(geo.width, geo.height);
  else win.setSize(1360, 880);
  if (geo.x != null && geo.y != null) win.setPosition(geo.x, geo.y);
  win.setTitle("Trame");
  // macOS resets the title to the binary name ("Trame.dylib") after webview init — re-apply
  for (const ms of [300, 1200, 4000]) {
    setTimeout(() => {
      try {
        win.setTitle("Trame");
      } catch { /* window gone */ }
    }, ms);
  }
  try {
    win.addEventListener("focus", () => win.setTitle("Trame"));
  } catch { /* focus events unsupported on this backend */ }
  let t: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const [width, height] = win.getSize();
        const [x, y] = win.getPosition();
        await Deno.writeTextFile(WINDOW_FILE, JSON.stringify({ width, height, x, y }));
      } catch { /* window gone */ }
    }, 400);
  };
  win.addEventListener("resize", persist);
  win.addEventListener("move", persist);
}
