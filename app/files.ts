// Scans the configured report directories for *.html exploration reports and
// *.excalidraw drawings so the Explore view can search files on disk alongside
// published reports. Paths come from the UI-editable settings file, falling back
// to the TRACKER_REPORT_PATHS env var.
import { HOME_DIR, REMOTE_PG, REPORT_PATHS, SETTINGS_FILE } from "./config.ts";

export type FileHit = { path: string; name: string; mtime: string };

const expand = (p: string) => p.trim().replace(/^~(?=\/|$)/, HOME_DIR);

export type ExploreConfig = {
  paths: string[];
  ignore: string[];
  starred: string[];
  htmlFilter: "smart" | "all";
  source: "settings" | "env";
  remotePg: string; // password always stripped — never shipped to the UI
  remoteSource: "settings" | "env" | null;
  remoteHasPassword: boolean;
};

// The URL and password are stored as separate settings keys (the UI keeps them
// in separate fields); they are only composed here, at connection time.
function withPassword(url: string, password: string): string {
  if (!password) return url;
  try {
    const u = new URL(url);
    u.password = password;
    return u.toString();
  } catch {
    return url;
  }
}
function stripPassword(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}
function urlPassword(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

// What sync would use if these (possibly unsaved) UI fields were saved: blank
// password falls back to the stored one, blank URL to the effective config.
export async function resolveRemotePg(url: string, password: string): Promise<string | null> {
  url = url.trim();
  if (!url) return getRemotePg();
  let pw = password.trim() || urlPassword(url);
  if (!pw) {
    try {
      const s = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
      if (typeof s.remotePgPassword === "string") pw = s.remotePgPassword;
    } catch { /* none stored */ }
  }
  return withPassword(stripPassword(url), pw);
}

// The hub URL is UI-configurable (settings.json) with the env var as fallback,
// re-read on every sync pass so a settings change applies without a restart.
export async function getRemotePg(): Promise<string | null> {
  try {
    const settings = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
    if (typeof settings.remotePg === "string" && settings.remotePg.trim()) {
      const pw = typeof settings.remotePgPassword === "string" ? settings.remotePgPassword : "";
      return withPassword(settings.remotePg.trim(), pw);
    }
  } catch { /* no settings file yet */ }
  return REMOTE_PG || null;
}

export async function getReportPaths(): Promise<ExploreConfig> {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
  } catch { /* no settings file yet */ }
  const list = (k: string) =>
    Array.isArray(settings[k]) ? (settings[k] as string[]).map((p) => p.trim()).filter(Boolean) : [];
  const ignore = list("ignorePaths");
  const starred = list("starredPaths");
  const htmlFilter = settings.htmlFilter === "all" ? "all" as const : "smart" as const;
  const savedRemote = typeof settings.remotePg === "string" ? settings.remotePg.trim() : "";
  const savedPw = typeof settings.remotePgPassword === "string" ? settings.remotePgPassword : "";
  const effective = savedRemote || REMOTE_PG;
  const remotePg = stripPassword(effective);
  const remoteSource = savedRemote ? "settings" as const : REMOTE_PG ? "env" as const : null;
  const remoteHasPassword = Boolean(savedRemote ? savedPw || urlPassword(savedRemote) : urlPassword(REMOTE_PG));
  if (Array.isArray(settings.reportPaths)) {
    return { paths: list("reportPaths").map(expand), ignore, starred, htmlFilter, source: "settings", remotePg, remoteSource, remoteHasPassword };
  }
  return { paths: REPORT_PATHS, ignore, starred, htmlFilter, source: "env", remotePg, remoteSource, remoteHasPassword };
}

export async function saveExploreSettings(
  patch: {
    reportPaths?: string[];
    ignorePaths?: string[];
    starredPaths?: string[];
    htmlFilter?: "smart" | "all";
    remotePg?: string;
    remotePgPassword?: string;
  },
): Promise<void> {
  await Deno.mkdir(SETTINGS_FILE.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
  } catch { /* fresh file */ }
  if (patch.reportPaths) settings.reportPaths = patch.reportPaths.map((p) => p.trim()).filter(Boolean);
  if (patch.ignorePaths) settings.ignorePaths = patch.ignorePaths.map((p) => p.trim()).filter(Boolean);
  if (patch.starredPaths) settings.starredPaths = patch.starredPaths.map((p) => p.trim()).filter(Boolean);
  if (patch.htmlFilter) settings.htmlFilter = patch.htmlFilter;
  if (patch.remotePg !== undefined) {
    let url = patch.remotePg.trim();
    let pw = patch.remotePgPassword?.trim() ?? "";
    // a full URL pasted with an embedded password gets split on save
    if (!pw) pw = urlPassword(url);
    url = stripPassword(url);
    if (url) {
      settings.remotePg = url;
      if (pw) settings.remotePgPassword = pw;
      // blank password = keep the stored one (the UI never gets it back)
    } else {
      // empty clears the override — env var (or offline) takes back over
      delete settings.remotePg;
      delete settings.remotePgPassword;
    }
  }
  await Deno.writeTextFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  // the URL may carry the hub password — keep the file private
  await Deno.chmod(SETTINGS_FILE, 0o600).catch(() => {});
  cache = null; // rescan with the new config
}

// Ignore entries, three flavors:
//  - bare name ("externals", "htmlcov")     → that directory anywhere (same as **/name)
//  - path prefix ("~/Projects/x/devops")    → that subtree
//  - glob ("**/htmlcov", "~/P/**/coverage", "**/*.min.html") → matched on full paths
// deno-lint-ignore no-import-prefix -- single std helper, not worth an import-map entry
import { globToRegExp } from "jsr:@std/path@^1/glob-to-regexp";

const GLOB_CHARS = /[*?[\]{}]/;
type IgnoreRules = { names: Set<string>; prefixes: string[]; globs: RegExp[] };
function ignoreRules(ignore: string[]): IgnoreRules {
  const names = new Set<string>();
  const prefixes: string[] = [];
  const globs: RegExp[] = [];
  for (const e of ignore) {
    // "**/name" with nothing else is just the bare-name rule
    const m = e.match(/^\*\*\/([^/*?[\]{}]+)$/);
    if (m) {
      names.add(m[1]);
    } else if (GLOB_CHARS.test(e)) {
      const pattern = expand(e);
      // relative globs match anywhere: anchor them under any prefix
      globs.push(globToRegExp(pattern.startsWith("/") ? pattern : `**/${pattern}`, { globstar: true }));
    } else if (e.includes("/")) {
      prefixes.push(expand(e).replace(/\/+$/, ""));
    } else {
      names.add(e);
    }
  }
  return { names, prefixes, globs };
}
const ignoredDir = (name: string, path: string, ig: IgnoreRules) =>
  ig.names.has(name) ||
  ig.prefixes.some((p) => path === p || path.startsWith(p + "/")) ||
  ig.globs.some((g) => g.test(path));

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".cache", ".venv", "venv", "coverage", "target"]);
const MAX_HITS = 500;
const CACHE_MS = 60_000;

async function walk(dir: string, depth: number, out: FileHit[], ig: IgnoreRules): Promise<void> {
  if (depth < 0 || out.length >= MAX_HITS) return;
  try {
    // readDir errors surface lazily during iteration — keep the loop inside the try
    for await (const e of Deno.readDir(dir)) {
      if (out.length >= MAX_HITS) return;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        // skip heavy/hidden dirs, but .scratch is a common home for generated reports
        if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".scratch")) continue;
        if (ignoredDir(e.name, p, ig)) continue;
        await walk(p, depth - 1, out, ig);
      } else if (e.isFile && (e.name.endsWith(".html") || e.name.endsWith(".excalidraw"))) {
        // bare-name rules apply to files as well ("404.html" ignores it anywhere)
        if (ig.names.has(e.name)) continue;
        if (ig.prefixes.some((pre) => p.startsWith(pre + "/")) || ig.globs.some((g) => g.test(p))) continue;
        try {
          const st = await Deno.stat(p);
          out.push({ path: p, name: e.name, mtime: st.mtime?.toISOString() ?? "" });
        } catch { /* raced deletion */ }
      }
    }
  } catch { /* unreadable dir — skip */ }
}

let cache: { at: number; hits: FileHit[] } | null = null;

// "Smart" filter: keep only self-contained documents — the signature of a generated
// report. App shells and built sites reference LOCAL js/css assets ("/assets/x.js",
// "./main.tsx"); reports inline everything (CDN references are fine and stay allowed).
// Files named *.ai.html bypass the sniff entirely (explicit convention override).
const LOCAL_ASSET = /(?:src|href)\s*=\s*["'](?:\.\.?\/|\/(?!\/))[^"']*?\.(?:m?js|css|tsx?)(?:[?#][^"']*)?["']/i;
const sniffCache = new Map<string, { mtime: string; report: boolean }>();

async function isReport(hit: FileHit): Promise<boolean> {
  if (!hit.name.endsWith(".html")) return true; // the sniff only makes sense for html
  if (hit.name.endsWith(".ai.html")) return true;
  const cached = sniffCache.get(hit.path);
  if (cached && cached.mtime === hit.mtime) return cached.report;
  let report: boolean;
  try {
    const f = await Deno.open(hit.path, { read: true });
    const buf = new Uint8Array(6144);
    const n = (await f.read(buf)) ?? 0;
    f.close();
    report = !LOCAL_ASSET.test(new TextDecoder().decode(buf.subarray(0, n)));
  } catch {
    report = false;
  }
  sniffCache.set(hit.path, { mtime: hit.mtime, report });
  return report;
}

export async function scanReportFiles(force = false): Promise<FileHit[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.hits;
  const { paths, ignore, htmlFilter } = await getReportPaths();
  const ig = ignoreRules(ignore);
  let hits: FileHit[] = [];
  for (const root of paths) await walk(root, 4, hits, ig);
  if (htmlFilter === "smart") {
    const keep = await Promise.all(hits.map(isReport));
    hits = hits.filter((_, i) => keep[i]);
  }
  hits.sort((a, b) => b.mtime.localeCompare(a.mtime));
  cache = { at: Date.now(), hits };
  return hits;
}

// Resolve a path and verify it lives under one of the configured roots.
async function allowedPath(path: string): Promise<string | null> {
  let real: string;
  try {
    real = await Deno.realPath(path);
  } catch {
    return null;
  }
  const { paths } = await getReportPaths();
  const allowed = await Promise.all(paths.map(async (r) => {
    try {
      const rr = await Deno.realPath(r);
      return real === rr || real.startsWith(rr + "/");
    } catch {
      return false;
    }
  }));
  return allowed.some(Boolean) ? real : null;
}

export async function readReportFile(path: string): Promise<string | null> {
  const real = await allowedPath(path);
  return real === null ? null : await Deno.readTextFile(real);
}

// Save an edited scene back to disk (the standalone browser editor posts here).
export async function writeReportFile(path: string, content: string): Promise<boolean> {
  const real = await allowedPath(path);
  if (real === null || !real.endsWith(".excalidraw")) return false;
  await Deno.writeTextFile(real, content);
  return true;
}

// Delete a report file — system trash when available (recoverable), unlink as fallback.
export async function deleteReportFile(path: string): Promise<{ ok: boolean; trashed: boolean }> {
  const real = await allowedPath(path);
  if (real === null) return { ok: false, trashed: false };
  try {
    const out = await new Deno.Command("gio", { args: ["trash", real], stdout: "null", stderr: "null" })
      .output();
    if (out.success) {
      cache = null;
      return { ok: true, trashed: true };
    }
  } catch { /* gio unavailable (e.g. macOS) — fall through */ }
  await Deno.remove(real);
  cache = null;
  return { ok: true, trashed: false };
}
