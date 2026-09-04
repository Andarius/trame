// A status is now a user-defined column key (the built-ins are active/paused/blocked/done).
export type Status = string;
export type StatusDef = {
  id: string;
  key: string;
  label: string;
  color: string;
  terminal: boolean;
  sort_key: string;
};

export type Session = {
  id: string;
  title: string;
  status: Status;
  client_id: string | null;
  page_id: string | null;
  repo_path: string | null;
  branch: string | null;
  next_step: string | null;
  specs_page_id: string | null;
  pr_url: string | null;
  summary: string;
  last_touched: string;
  claude_id: string | null;
  agent: string | null;
};
export type Story = {
  id: string;
  title: string;
  brief: string;
  client_id: string | null;
  status: string;
};
export type Project = { id: string; name: string; color: string | null; icon: string | null };
export type BoardPage = {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  icon: string | null;
  client_id: string | null;
  color: string | null;
};
export type BoardData = {
  projects: Project[];
  stories: Story[];
  sessions: Session[];
  pages: BoardPage[];
  statuses: StatusDef[];
};
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
  page_id: string | null;
  created_at: string;
};
export type Report = ReportMeta & { html: string };

export type SessionEvent = {
  id: string;
  at: string;
  agent?: string | null;
  summary: string | null;
  kind: string;
};

export type SearchHit = {
  kind: "session" | "client" | "page" | "database";
  id: string;
  title: string;
  sub: string;
  icon: string;
  meta: string; // session status, or page kind (story|page), or "database"
  color: string; // project (client) chip color, "" elsewhere
  at: string;
};
export const search = (q: string) =>
  fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) =>
    r.json() as Promise<SearchHit[]>
  );

export const getBoard = () =>
  fetch("/api/board").then((r) => r.json() as Promise<BoardData>);
export const getStatus = () =>
  fetch("/api/status").then((r) => r.json() as Promise<AppStatus>);
export const getReports = () =>
  fetch("/api/reports").then((r) => r.json() as Promise<ReportMeta[]>);
export const getReport = (id: string) =>
  fetch(`/api/reports/${id}`).then((r) => r.json() as Promise<Report>);
export const getEvents = (id: string) =>
  fetch(`/api/sessions/${id}/events`).then((r) =>
    r.json() as Promise<SessionEvent[]>
  );

export type FileHit = { path: string; name: string; mtime: string };
export type Settings = {
  paths: string[];
  ignore: string[];
  starred: string[];
  htmlFilter: "smart" | "all";
  source: "settings" | "env";
  hubApi: string; // the token never comes back to the UI
  hubSource: "settings" | "env" | null;
  hubHasToken: boolean;
  authorName: string;
  authorAvatar: string;
};
export const getSettings = () =>
  fetch("/api/settings").then((r) => r.json() as Promise<Settings>);
export const patchSettings = (
  patch: {
    reportPaths?: string[];
    ignorePaths?: string[];
    starredPaths?: string[];
    htmlFilter?: "smart" | "all";
    hubApi?: string;
    hubApiToken?: string;
    authorName?: string;
    authorAvatar?: string;
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
  fetch(`/api/report-files${force ? "?force" : ""}`).then((r) =>
    r.json() as Promise<FileHit[]>
  );
export const deleteReportFile = (path: string) =>
  fetch("/api/report-files/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }).then((r) => r.json() as Promise<{ ok: boolean; trashed: boolean }>);
export const getReportFileContent = (path: string) =>
  fetch(`/api/report-files/content?path=${encodeURIComponent(path)}`)
    .then((r) => r.json() as Promise<{ path: string; html: string }>);
// Live directory listing for the folder block (gated to Explore's scanned roots).
export const listFolder = (path: string) =>
  fetch(`/api/folder?path=${encodeURIComponent(path)}`)
    .then((r) =>
      r.json() as Promise<
        { path: string; entries: FolderEntry[] } | { error: string }
      >
    );
// Reveal a filesystem path in the OS (file manager / default app).
export const openPath = (path: string) =>
  post("/api/open-path", { path }).then((r) =>
    r.json() as Promise<{ ok?: boolean; error?: string }>
  );

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Pasted images — raw bytes up, {id} back; referenced as /api/assets/<id>.
export const uploadAsset = (file: Blob) =>
  fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  }).then((r) => r.json() as Promise<{ id?: string; error?: string }>);

export const saveSession = (s: Record<string, unknown>) =>
  post("/api/sessions", s);
// find-or-create the session's spec page (deterministic id server-side)
export const ensureSpecsPage = (id: string) =>
  post(`/api/sessions/${id}/specs-page`, {}).then((r) =>
    r.json() as Promise<{ page_id: string }>
  );
export const deleteSession = (id: string) =>
  post(`/api/sessions/${id}/delete`, {});
export const addLog = (id: string, summary: string) =>
  post(`/api/sessions/${id}/events`, { summary });
export const updateStory = (id: string, patch: Record<string, unknown>) =>
  post(`/api/stories/${id}`, patch);
// Open in the system browser (the desktop webview has no window.open).
// target: app-relative path ("/report/…") or an absolute http(s) URL.
export const openInBrowser = (target: string) => post("/api/open", { target });
export type PrInfo = {
  state: string;
  title?: string;
  base?: string;
  // human label when part of a gh-stack chain, e.g. "stacked on fix/x" or "#42 stacked on top"
  stack?: string;
};
export const prInfo = (url: string) =>
  post("/api/pr-state", { url })
    .then((r) => r.json() as Promise<PrInfo>)
    .catch(() => ({ state: "unknown" } as PrInfo));
export const completePath = (path: string) =>
  fetch(`/api/fs/complete?path=${encodeURIComponent(path)}`)
    .then((r) => r.json() as Promise<{ dirs: string[] }>)
    .then((d) => d.dirs ?? [])
    .catch(() => [] as string[]);
export type ResumeMode = "window" | "tab" | "existing";
export type ResumeInfo = {
  ok: boolean;
  launched: boolean;
  local?: boolean;
  homeNode?: string | null;
  cmd: string;
  repo?: string;
  mode?: ResumeMode;
  reason?: "no-konsole" | "api-disabled";
  agent?: "claude" | "codex";
};
// `local` carries {repoPath, agent} for a transcript found by scanning this machine's
// own ~/.claude/~.codex (the Sessions view) — skips the sessions-table lookup entirely,
// so it works whether or not the session has ever been tracked as a Trame card.
export const resumeSession = (
  id: string,
  mode?: ResumeMode,
  local?: { repoPath: string; agent: "claude" | "codex" },
) =>
  post("/api/resume", {
    id,
    mode,
    repoPath: local?.repoPath,
    agent: local?.agent,
  }).then((r) => r.json() as Promise<ResumeInfo>);
export const probeResume = (
  id: string,
  local?: { repoPath: string; agent: "claude" | "codex" },
) =>
  post("/api/resume", {
    id,
    probe: true,
    repoPath: local?.repoPath,
    agent: local?.agent,
  }).then((r) => r.json() as Promise<ResumeInfo>);
// Bulk resume: konsole → one window with a tab per session; ghostty/others → one
// window per session.
export const resumeAllSessions = (
  sessions: { id: string; repoPath: string; agent: "claude" | "codex" }[],
) =>
  post("/api/resume-all", { sessions }).then((r) =>
    r.json() as Promise<
      { ok: boolean; launched: number; mode: string; error?: string }
    >
  );

export const setStatus = (id: string, status: Status) =>
  fetch(`/api/sessions/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });

export const createStatus = (
  s: { label: string; color: string; terminal?: boolean },
) => post("/api/statuses", s).then((r) => r.json() as Promise<{ id: string }>);
export const updateStatus = (
  id: string,
  patch: { label?: string; color?: string; terminal?: boolean },
) => post(`/api/statuses/${id}`, patch);
export const moveStatus = (id: string, dir: -1 | 1) =>
  post(`/api/statuses/${id}/move`, { dir });
export const deleteStatus = (id: string) =>
  post(`/api/statuses/${id}/delete`, {});

export const syncNow = () =>
  fetch("/api/sync", { method: "POST" }).then((r) =>
    r.json() as Promise<{ pulled: number; pushed: number } | null>
  );
export const testHub = (hubApi: string, hubApiToken: string) =>
  fetch("/api/hub/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hubApi, hubApiToken }),
  }).then((r) =>
    r.json() as Promise<{ ok: boolean; tls?: boolean; error?: string }>
  );

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
export type ColorRule = { lt?: number; color: string };
export type PropConfig = {
  format?: "plain" | "euro" | "dollar" | "percent";
  unit?: string; // free-text suffix (e.g. "s", "kg") — rendered muted after the value
  unit_prop?: string; // per-row unit from a sibling select/text column; unit is the fallback
  precision?: number;
  icon?: string | null; // custom column icon (emoji or image data-uri); else the type glyph
  // number visualization (Notion-style "Show as"): plain number, bar, or ring
  show_as?: "number" | "bar" | "ring";
  color?: string; // fixed color (bar/ring fill, or value color when color_apply is set)
  // value-dependent color: fixed single color, continuous good→bad scale, or threshold rules
  color_mode?: "fixed" | "scale" | "rules";
  color_apply?: "none" | "text" | "pill" | "dot" | "cell"; // where the color shows on plain numbers
  good?: "low" | "high"; // scale direction: which end of the range is green (default low)
  scale_min?: number; // manual scale range; unset = auto from the visible column values
  scale_max?: number;
  rules?: ColorRule[]; // ordered ladder: first rule with v < lt wins; lt unset = otherwise
  max?: number; // value that reads as 100% (default 100)
  show_value?: boolean; // show the numeric label next to the bar/ring (default true)
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
export type RelChip = { id: string; title: string; icon?: string | null };
export type Derived = number | string | null | { error: string };
export type UdbRow = {
  id: string;
  icon: string | null;
  sort_key: string;
  vals: Record<string, unknown>;
  relations: Record<string, RelChip[]>;
  derived: Record<string, Derived>;
};
// db.views holds the ViewTabs bundle (typed loosely here to avoid a cycle with udb/view.tsx; that module validates it)
export type Udb = {
  db: { id: string; name: string; icon: string | null; views: unknown };
  properties: UdbProp[];
  rows: UdbRow[];
};

const jsonOrThrow = async (r: Response) => {
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};

export const listUdbs = () =>
  fetch("/api/udb").then((r) => r.json() as Promise<UdbMeta[]>);
export const getUdb = (id: string) =>
  fetch(`/api/udb/${id}`).then((r) => r.json() as Promise<Udb>);
export const createUdb = (name: string) =>
  post("/api/udb", { name }).then((r) => r.json() as Promise<{ id: string }>);
export const updateUdb = (
  id: string,
  patch: { name?: string; icon?: string | null; views?: unknown },
) => post(`/api/udb/${id}`, patch);
export const deleteUdb = (id: string) => post(`/api/udb/${id}/delete`, {});
export const createUdbProp = (
  dbId: string,
  p: { name: string; type: PropType; config?: PropConfig },
) =>
  post(`/api/udb/${dbId}/props`, p).then(jsonOrThrow) as Promise<
    { id: string }
  >;
export const updateUdbProp = (
  id: string,
  patch: {
    name?: string;
    config?: PropConfig;
    width?: number | null;
    sort_key?: string;
  },
) => post(`/api/udb/props/${id}`, patch).then(jsonOrThrow);
export const deleteUdbProp = (id: string) =>
  post(`/api/udb/props/${id}/delete`, {});
export const createUdbRow = (
  dbId: string,
  vals?: Record<string, unknown>,
  icon?: string | null,
) =>
  post(`/api/udb/${dbId}/rows`, { vals, icon }).then((r) =>
    r.json() as Promise<{ id: string }>
  );
export const patchUdbRow = (
  id: string,
  vals: Record<string, unknown>,
  icon?: string | null,
) =>
  post(`/api/udb/rows/${id}`, icon === undefined ? { vals } : { vals, icon });
export const deleteUdbRow = (id: string) =>
  post(`/api/udb/rows/${id}/delete`, {});
export const setUdbLink = (
  propId: string,
  fromRow: string,
  toRow: string,
  remove = false,
) =>
  post("/api/udb/links", {
    prop_id: propId,
    from_row: fromRow,
    to_row: toRow,
    remove,
  });
export const listUdbIcons = () =>
  fetch("/api/udb/icons").then((r) => r.json() as Promise<string[]>);

export type UpdateInfo = {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string;
  canSelfUpdate: boolean;
  applied: boolean;
};
export const getUpdate = () =>
  fetch("/api/update").then((r) => r.json() as Promise<UpdateInfo>);
export const applyUpdate = () =>
  post("/api/update", {}).then((r) =>
    r.json() as Promise<{ ok: boolean; error?: string }>
  );

// pages — the nestable tree: project | story | page

export type PageKind = "page" | "story" | "project";
export type Block =
  | {
    type: "text" | "heading" | "todo";
    text: string;
    done?: boolean;
    indent?: number;
    id?: string;
  }
  | { type: "database"; db_id: string }
  | { type: "subpage"; page_id: string }
  | { type: "folder"; path: string; view?: "list" | "gallery"; id?: string }
  | {
    type: "html";
    html: string;
    data?: unknown;
    height?: number;
    id?: string;
  };
export type FolderEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  ext: string;
  isHtml: boolean;
};
export type PageComment = {
  id: string;
  page_id: string;
  block_id: string;
  anchor: string;
  body: string;
  author: string;
  author_avatar: string;
  author_id: string | null;
  resolved: boolean;
  updated_at: string;
  meta: string | null; // JSON string of agent generation stats, or null
  agent_status: "seen" | "answering" | "failed" | "answered" | null;
  agent_status_agent: string;
};

export type Identity = { userId: string | null; name: string; avatar: string };
export const getIdentity = () =>
  fetch("/api/identity").then((r) => r.json() as Promise<Identity>);

export type Presence = {
  id: string;
  kind: "viewer" | "watcher";
  name: string;
  avatar: string;
  page_id: string;
};
export const pingPresence = (pageId: string) =>
  fetch("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_id: pageId }),
  }).catch(() => {});
export const getPresence = (pageId: string) =>
  fetch(`/api/presence?page=${pageId}`).then((r) =>
    r.json() as Promise<Presence[]>
  );
export const startWatcher = (agent: string, pageId: string) =>
  fetch("/api/watcher/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, page: pageId }),
  }).then((r) =>
    r.json() as Promise<{ ok: boolean; launched: boolean; cmd: string }>
  );
export type PageMeta = {
  id: string;
  parent_id: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  status: string;
  client_id: string | null;
  color: string | null;
  /** tag keys, not ids — a page stays readable before the vocabulary arrives */
  tags: string[];
  sort_key: string;
  owner_id: string | null;
};
export type PageDetail = PageMeta & {
  brief: string;
  updated_at: string;
  content: Block[];
  children: PageMeta[];
  databases: {
    id: string;
    name: string;
    icon: string | null;
    row_count: number;
  }[];
  sessions: Session[];
  comments: PageComment[];
  links: SessionLink[];
};

// session <-> page-item link (anchored like comments: block id + text snapshot)
export type SessionLink = {
  id: string;
  session_id?: string;
  page_id?: string;
  block_id: string | null;
  anchor: string;
  page_title?: string;
  session_title?: string;
  session_status?: Status;
};
export const getSessionLinks = (id: string) =>
  fetch(`/api/sessions/${id}/links`).then((r) => r.json() as Promise<SessionLink[]>);
export const addSessionLink = (
  sessionId: string,
  l: { page_id: string; block_id?: string | null; anchor?: string },
) => post(`/api/sessions/${sessionId}/links`, l);
export const deleteSessionLink = (id: string) => post(`/api/links/${id}/delete`, {});

export const listPages = () =>
  fetch("/api/pages").then((r) => r.json() as Promise<PageMeta[]>);
export const getPage = (id: string) =>
  fetch(`/api/pages/${id}`).then((r) => r.json() as Promise<PageDetail>);
export const createPage = (
  p: {
    title?: string;
    parent_id?: string | null;
    kind?: PageKind;
    icon?: string | null;
    client_id?: string | null;
  },
) => post("/api/pages", p).then((r) => r.json() as Promise<{ id: string }>);
export const updatePage = (
  id: string,
  patch: {
    title?: string;
    icon?: string | null;
    brief?: string;
    status?: string;
    client_id?: string | null;
    content?: Block[];
    color?: string | null;
    tags?: string[];
  },
) => post(`/api/pages/${id}`, patch).then(jsonOrThrow);

export type Tag = {
  id: string;
  key: string;
  label: string;
  color: string;
  sort_key: string;
};
export const listTags = () =>
  fetch("/api/tags").then((r) => r.json() as Promise<Tag[]>);
// find-or-create: the same label always resolves to the same tag
export const ensureTag = (label: string, color?: string) =>
  post("/api/tags", { label, color }).then((r) =>
    r.json() as Promise<{ id: string; key: string }>
  );
export const updateTag = (id: string, patch: { label?: string; color?: string }) =>
  post(`/api/tags/${id}`, patch).then(jsonOrThrow);
export const deleteTag = (id: string) => post(`/api/tags/${id}/delete`, {});
export const deletePage = (id: string) => post(`/api/pages/${id}/delete`, {});
export const movePage = (
  id: string,
  to: { parent_id?: string | null; before_id?: string; after_id?: string },
) => post(`/api/pages/${id}/move`, to).then(jsonOrThrow);
export const attachUdbToPage = (dbId: string, pageId: string | null) =>
  post(`/api/udb/${dbId}`, { page_id: pageId });

// Inline page comments (block-level notes anchored by Block.id).
export const listComments = (pageId: string) =>
  fetch(`/api/comments?page=${pageId}`).then((r) =>
    r.json() as Promise<PageComment[]>
  );
export const createComment = (
  c: { page_id: string; block_id: string; anchor?: string; body: string },
) => post("/api/comments", c).then((r) => r.json() as Promise<{ id: string }>);
export const updateComment = (
  id: string,
  patch: { body?: string; resolved?: boolean },
) => post(`/api/comments/${id}`, patch).then(jsonOrThrow);
export const deleteComment = (id: string) =>
  post(`/api/comments/${id}/delete`, {});

// Share a page across Trame instances: export the subtree to a file (native save
// dialog), import a bundle file back (native open dialog). Both hit native dialogs
// server-side, so the browser gets a result, not a download.
export const exportPage = (id: string) =>
  post(`/api/pages/${id}/export`, {}).then((r) =>
    r.json() as Promise<{ path?: string; cancelled?: boolean; error?: string }>
  );
export const importPage = (parentId: string | null = null) =>
  post("/api/pages/import", { parent_id: parentId })
    .then((r) =>
      r.json() as Promise<{ id?: string; cancelled?: boolean; error?: string }>
    );

// Claude Code + Codex import
export type ClaudeSession = {
  source: "claude" | "codex";
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
export type ClaudeGroup = {
  repoPath: string;
  repoName: string;
  suggestedClient: string;
  sessions: ClaudeSession[];
};
export type ClaudeScan = {
  groups: ClaudeGroup[];
  total: number;
  dir: string;
  node: string;
};
export type ClaudeImportItem = {
  source: "claude" | "codex";
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
  fetch(`/api/import/claude?days=${days}`).then((r) =>
    r.json() as Promise<ClaudeScan>
  );
export const runClaudeImport = (items: ClaudeImportItem[]) =>
  post("/api/import/claude", { items }).then((r) =>
    r.json() as Promise<{ imported: number; skipped: number }>
  );
export const setClaudeIgnored = (
  claudeId: string,
  ignored: boolean,
  source: "claude" | "codex" = "claude",
) => post("/api/import/claude/ignore", { claudeId, ignored, source });

// Plugins — first-party panels, compile-time registered (web/src/plugins/),
// enabled per device via settings. Plugin-specific endpoints live with the plugin.
export type PluginManifest = {
  id: string;
  label: string;
  glyph: string;
  description: string;
  enabled: boolean;
  badge: number | null;
};
export const getPlugins = () =>
  fetch("/api/plugins").then((r) => r.json() as Promise<PluginManifest[]>);
export const setPluginEnabled = (id: string, enabled: boolean) =>
  post(`/api/plugins/${id}/enable`, { enabled });
export const getPluginSettings = (id: string) =>
  fetch(`/api/plugins/${id}/settings`).then((r) =>
    r.json() as Promise<Record<string, unknown>>
  );
export const savePluginSettings = (
  id: string,
  patch: Record<string, unknown>,
) =>
  post(`/api/plugins/${id}/settings`, patch).then((r) =>
    r.json() as Promise<Record<string, unknown>>
  );

// Sharing (phase 7): per-page grants for guest users, enforced by the hub API.
export type UserInfo = { id: string; name: string; role: "member" | "guest" };
export type PageShare = {
  id: string;
  user_id: string;
  role: "viewer" | "editor";
  name: string;
};
export const listUsers = () =>
  fetch("/api/users").then((r) => r.json() as Promise<UserInfo[]>);
export const listShares = (pageId: string) =>
  fetch(`/api/shares?page=${pageId}`).then((r) =>
    r.json() as Promise<PageShare[]>
  );
export const setShare = (
  s: { page_id: string; user_id: string; role: "viewer" | "editor" },
) => post("/api/shares", s).then((r) => r.json() as Promise<{ id: string }>);
export const revokeShare = (id: string) => post(`/api/shares/${id}/delete`, {});

// Public share links (read-only browser view; token shown once at creation).
export type PageLink = { id: string; updated_at: string };
export const createShareLink = (pageId: string) =>
  post("/api/links", { page_id: pageId }).then((r) =>
    r.json() as Promise<{ id: string; url: string | null; token: string }>
  );
export const listShareLinks = (pageId: string) =>
  fetch(`/api/links?page=${pageId}`).then((r) =>
    r.json() as Promise<{ base: string | null; links: PageLink[] }>
  );
export const revokeShareLink = (id: string) =>
  post(`/api/links/${id}/delete`, {});
