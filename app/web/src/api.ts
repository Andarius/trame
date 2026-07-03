export type Status = "active" | "paused" | "blocked" | "done";

export type Session = {
  id: string;
  title: string;
  status: Status;
  client_id: string | null;
  objective_id: string | null;
  repo_path: string | null;
  branch: string | null;
  next_step: string | null;
  pr_url: string | null;
  summary: string;
  last_touched: string;
};
export type Objective = { id: string; title: string; story: string; client_id: string | null; status: string };
export type Client = { id: string; name: string; color: string | null };
export type BoardData = { clients: Client[]; objectives: Objective[]; sessions: Session[] };
export type AppStatus = {
  nodeId: string;
  remote: boolean;
  lastSync: { at: string; pulled: number; pushed: number } | null;
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
