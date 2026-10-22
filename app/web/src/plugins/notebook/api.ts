// Notebook plugin client: calls against /api/plugins/notebook.
export type RunningServer = { url: string; rootDir: string | null; pid: number; version?: string };
export type NotebookStatus = {
  server: { url: string; upstream: string; rootDir: string | null; mode: "spawned" | "attached" } | null;
  starting: boolean;
  error: string | null;
  log: string[];
  running: RunningServer[];
  rootDir: string;
};
export type NotebookSettings = { enabled: boolean; command: string; rootDir: string; defaultCommand: string };

const BASE = "/api/plugins/notebook";

async function call<T>(sub: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${sub}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
}

export const getStatus = () => call<NotebookStatus>("/status");
export const startServer = (cwd?: string) => call<{ starting: boolean }>("/start", { cwd });
export const attachServer = (url: string, token?: string) => call<NotebookStatus>("/attach", { url, token });
export const stopServer = () => call<NotebookStatus>("/stop", {});
export const setTheme = (theme: "light" | "dark") => call<{ theme: string; changed: boolean }>("/theme", { theme });
export const exportHtml = (path: string, to: "report" | "file") =>
  call<{ id?: string; url?: string; file?: string }>("/export", { path, to });

/** The notebook path in a Jupyter URL (`…/tree/<path>` or `…/notebooks/<path>`), or null on the launcher. */
export function notebookPath(pathname: string): string | null {
  const m = /\/(?:tree|notebooks)\/(.+)$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/\+/g, " ");
  } catch {
    return m[1];
  }
}

/** Trame's effective theme: the forced data-theme, else the OS preference. */
export function effectiveTheme(): "light" | "dark" {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const openNotebook = (path: string) => call<{ url: string }>("/open", { path });

const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".ipynb_checkpoints", ".git"]);

/** Notebook paths under the server root, a few levels deep, through the proxy's contents API. */
export async function listNotebooks(dir = "", depth = 2): Promise<string[]> {
  const r = await fetch(`${BASE}/j/api/contents/${dir}?content=1`);
  if (!r.ok) return [];
  const data = await r.json() as { content?: { name: string; path: string; type: string }[] };
  const found: string[] = [];
  const dirs: string[] = [];
  for (const c of data.content ?? []) {
    if (c.name.startsWith(".") || SKIP_DIRS.has(c.name)) continue;
    if (c.type === "notebook") found.push(c.path);
    else if (c.type === "directory" && depth > 0) dirs.push(c.path);
  }
  const nested = await Promise.all(dirs.map((d) => listNotebooks(d, depth - 1)));
  return [...found, ...nested.flat()].sort((a, b) => a.localeCompare(b));
}

/** A pasted Jupyter URL: the server base to attach to, its token if the URL carries one, and the notebook path if any. */
export function parseLabUrl(raw: string): { url: string; token: string | null; path: string | null } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const i = u.pathname.search(/\/(lab|tree|notebooks)(\/|$)/);
  const basePath = i >= 0 ? u.pathname.slice(0, i + 1) : u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return { url: `${u.origin}${basePath}`, token: u.searchParams.get("token"), path: notebookPath(u.pathname) };
}
