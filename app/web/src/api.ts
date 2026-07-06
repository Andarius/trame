export type Status = "active" | "paused" | "blocked" | "done";

export type Session = {
  id: string;
  title: string;
  status: Status;
  client_id: string | null;
  objective_id: string | null;
  page_id: string | null;
  repo_path: string | null;
  branch: string | null;
  next_step: string | null;
  pr_url: string | null;
  summary: string;
  last_touched: string;
};
export type Objective = { id: string; title: string; story: string; client_id: string | null; status: string };
export type Client = { id: string; name: string; color: string | null };
export type BoardPage = {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  icon: string | null;
  client_id: string | null;
};
export type BoardData = { clients: Client[]; objectives: Objective[]; sessions: Session[]; pages: BoardPage[] };
export type AppStatus = {
  nodeId: string;
  remote: boolean;
  lastSync: { at: string; pulled: number; pushed: number } | null;
  dataDir?: string;
  desktop?: boolean;
  version?: string;
};

export type ReportMeta = {
  id: string;
  title: string;
  client_id: string | null;
  objective_id: string | null;
  created_at: string;
};
export type Report = ReportMeta & { html: string };

export type SessionEvent = { id: string; at: string; summary: string | null; kind: string };

export const getBoard = () => fetch("/api/board").then((r) => r.json() as Promise<BoardData>);
export const getStatus = () => fetch("/api/status").then((r) => r.json() as Promise<AppStatus>);
export const getReports = () => fetch("/api/reports").then((r) => r.json() as Promise<ReportMeta[]>);
export const getReport = (id: string) => fetch(`/api/reports/${id}`).then((r) => r.json() as Promise<Report>);
export const getEvents = (id: string) =>
  fetch(`/api/sessions/${id}/events`).then((r) => r.json() as Promise<SessionEvent[]>);

export type FileHit = { path: string; name: string; mtime: string };
export type Settings = {
  paths: string[];
  ignore: string[];
  starred: string[];
  htmlFilter: "smart" | "all";
  source: "settings" | "env";
};
export const getSettings = () => fetch("/api/settings").then((r) => r.json() as Promise<Settings>);
export const patchSettings = (
  patch: {
    reportPaths?: string[];
    ignorePaths?: string[];
    starredPaths?: string[];
    htmlFilter?: "smart" | "all";
  },
) =>
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r.json() as Promise<Settings>);
export const saveSettings = (reportPaths: string[], ignorePaths: string[]) =>
  patchSettings({ reportPaths, ignorePaths });
export const getReportFiles = (force = false) =>
  fetch(`/api/report-files${force ? "?force" : ""}`).then((r) => r.json() as Promise<FileHit[]>);
export const deleteReportFile = (path: string) =>
  fetch("/api/report-files/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }).then((r) => r.json() as Promise<{ ok: boolean; trashed: boolean }>);
export const getReportFileContent = (path: string) =>
  fetch(`/api/report-files/content?path=${encodeURIComponent(path)}`)
    .then((r) => r.json() as Promise<{ path: string; html: string }>);

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const saveSession = (s: Record<string, unknown>) => post("/api/sessions", s);
export const deleteSession = (id: string) => post(`/api/sessions/${id}/delete`, {});
export const addLog = (id: string, summary: string) => post(`/api/sessions/${id}/events`, { summary });
export const updateObjective = (id: string, patch: Record<string, unknown>) => post(`/api/objectives/${id}`, patch);
// Open in the system browser (the desktop webview has no window.open).
// target: app-relative path ("/report/…") or an absolute http(s) URL.
export const openInBrowser = (target: string) => post("/api/open", { target });

export const setStatus = (id: string, status: Status) =>
  fetch(`/api/sessions/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });

export const syncNow = () => fetch("/api/sync", { method: "POST" });

// user-defined databases

export type PropType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "url"
  | "checkbox"
  | "relation"
  | "formula"
  | "rollup";

export type SelectOption = { id: string; name: string; color: string };
export type PropConfig = {
  format?: "plain" | "euro" | "dollar" | "percent";
  precision?: number;
  options?: SelectOption[];
  end?: boolean;
  target_db?: string;
  pair?: string;
  owner?: boolean;
  reverse_name?: string;
  expr?: string;
  relation_prop?: string;
  target_prop?: string;
  agg?: "count" | "sum" | "avg" | "min" | "max" | "latest";
  date_prop?: string;
};

export type UdbProp = {
  id: string;
  db_id: string;
  name: string;
  type: PropType;
  config: PropConfig;
  sort_key: string;
  width: number | null;
};

export type UdbMeta = {
  id: string;
  name: string;
  icon: string | null;
  page_id: string | null;
  sort_key: string;
  row_count: number;
};
export type RelChip = { id: string; title: string };
export type Derived = number | string | null | { error: string };
export type UdbRow = {
  id: string;
  icon: string | null;
  sort_key: string;
  vals: Record<string, unknown>;
  relations: Record<string, RelChip[]>;
  derived: Record<string, Derived>;
};
export type Udb = { db: { id: string; name: string; icon: string | null }; properties: UdbProp[]; rows: UdbRow[] };

const jsonOrThrow = async (r: Response) => {
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};

export const listUdbs = () => fetch("/api/udb").then((r) => r.json() as Promise<UdbMeta[]>);
export const getUdb = (id: string) => fetch(`/api/udb/${id}`).then((r) => r.json() as Promise<Udb>);
export const createUdb = (name: string) => post("/api/udb", { name }).then((r) => r.json() as Promise<{ id: string }>);
export const updateUdb = (id: string, patch: { name?: string; icon?: string | null }) => post(`/api/udb/${id}`, patch);
export const deleteUdb = (id: string) => post(`/api/udb/${id}/delete`, {});
export const createUdbProp = (dbId: string, p: { name: string; type: PropType; config?: PropConfig }) =>
  post(`/api/udb/${dbId}/props`, p).then(jsonOrThrow) as Promise<{ id: string }>;
export const updateUdbProp = (
  id: string,
  patch: { name?: string; config?: PropConfig; width?: number | null; sort_key?: string },
) => post(`/api/udb/props/${id}`, patch).then(jsonOrThrow);
export const deleteUdbProp = (id: string) => post(`/api/udb/props/${id}/delete`, {});
export const createUdbRow = (dbId: string, vals?: Record<string, unknown>, icon?: string | null) =>
  post(`/api/udb/${dbId}/rows`, { vals, icon }).then((r) => r.json() as Promise<{ id: string }>);
export const patchUdbRow = (id: string, vals: Record<string, unknown>, icon?: string | null) =>
  post(`/api/udb/rows/${id}`, icon === undefined ? { vals } : { vals, icon });
export const deleteUdbRow = (id: string) => post(`/api/udb/rows/${id}/delete`, {});
export const setUdbLink = (propId: string, fromRow: string, toRow: string, remove = false) =>
  post("/api/udb/links", { prop_id: propId, from_row: fromRow, to_row: toRow, remove });
export const listUdbIcons = () => fetch("/api/udb/icons").then((r) => r.json() as Promise<string[]>);

export type UpdateInfo = {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string;
  canSelfUpdate: boolean;
  applied: boolean;
};
export const getUpdate = () => fetch("/api/update").then((r) => r.json() as Promise<UpdateInfo>);
export const applyUpdate = () =>
  post("/api/update", {}).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);

// pages — the nestable tree; kind='project' pages are the former objectives

export type PageKind = "page" | "project";
export type Block =
  | { type: "text" | "heading" | "todo"; text: string; done?: boolean }
  | { type: "database"; db_id: string }
  | { type: "subpage"; page_id: string };
export type PageMeta = {
  id: string;
  parent_id: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  status: string;
  client_id: string | null;
  sort_key: string;
};
export type PageDetail = PageMeta & {
  story: string;
  content: Block[];
  children: PageMeta[];
  databases: { id: string; name: string; icon: string | null; row_count: number }[];
  sessions: Session[];
};

export const listPages = () => fetch("/api/pages").then((r) => r.json() as Promise<PageMeta[]>);
export const getPage = (id: string) => fetch(`/api/pages/${id}`).then((r) => r.json() as Promise<PageDetail>);
export const createPage = (
  p: { title?: string; parent_id?: string | null; kind?: PageKind; icon?: string | null; client_id?: string | null },
) => post("/api/pages", p).then((r) => r.json() as Promise<{ id: string }>);
export const updatePage = (
  id: string,
  patch: {
    title?: string;
    icon?: string | null;
    story?: string;
    status?: string;
    client_id?: string | null;
    content?: Block[];
  },
) => post(`/api/pages/${id}`, patch).then(jsonOrThrow);
export const deletePage = (id: string) => post(`/api/pages/${id}/delete`, {});
export const movePage = (id: string, to: { parent_id?: string | null; before_id?: string; after_id?: string }) =>
  post(`/api/pages/${id}/move`, to).then(jsonOrThrow);
export const attachUdbToPage = (dbId: string, pageId: string | null) => post(`/api/udb/${dbId}`, { page_id: pageId });

// Claude Code import
export type ClaudeSession = {
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  lastActive: string;
  suggestedStatus: "active" | "paused";
  suggestedClient: string;
  suggestedProject: string;
  alreadyImported: boolean;
  ignored: boolean;
};
export type ClaudeGroup = { repoPath: string; repoName: string; suggestedClient: string; sessions: ClaudeSession[] };
export type ClaudeScan = { groups: ClaudeGroup[]; total: number; dir: string };
export type ClaudeImportItem = {
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  client: string;
  project: string | null;
  status: "active" | "paused";
  lastActive: string;
};
export const scanClaudeImport = (days: number) =>
  fetch(`/api/import/claude?days=${days}`).then((r) => r.json() as Promise<ClaudeScan>);
export const runClaudeImport = (items: ClaudeImportItem[]) =>
  post("/api/import/claude", { items }).then((r) => r.json() as Promise<{ imported: number; skipped: number }>);
export const setClaudeIgnored = (claudeId: string, ignored: boolean) =>
  post("/api/import/claude/ignore", { claudeId, ignored });
