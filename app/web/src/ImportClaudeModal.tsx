import { useEffect, useRef, useState } from "react";
import {
  type BoardData,
  type ClaudeGroup,
  type ClaudeImportItem,
  type ClaudeScan,
  type ClaudeSession,
  runClaudeImport,
  scanClaudeImport,
  setClaudeIgnored,
} from "./api";
import { Check, Footer, label, pill } from "./modal-ui";
import { IconButton, Modal, Popover, Select, timeAgo } from "./ui";

const AUTO_PROJECT = "__auto__";
const NEW_PROJECT = "__new__";
const NEW_CLIENT = "__new_client__";

export function ImportClaudeModal(
  { board, onClose, onDone }: { board: BoardData; onClose: () => void; onDone: (imported: number) => void },
) {
  const [days, setDays] = useState(7);
  const [scan, setScan] = useState<ClaudeScan | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // per-repo overrides; unset = suggestion
  const [clients, setClients] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Record<string, string>>({});
  const [newProjects, setNewProjects] = useState<Record<string, string>>({});
  const [newClients, setNewClients] = useState<Record<string, string>>({});
  const [stateFilter, setStateFilter] = useState<"new" | "imported" | "ignored" | "all">("new");
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setScan(null);
    scanClaudeImport(days).then((s) => {
      if (!alive) return;
      setScan(s);
      setChecked(
        new Set(
          s.groups.flatMap((g) => g.sessions.filter((x) => !x.alreadyImported && !x.ignored).map((x) => x.claudeId)),
        ),
      );
    });
    return () => {
      alive = false;
    };
  }, [days]);

  const ignore = (id: string, source: "claude" | "codex", ignored: boolean) => {
    setClaudeIgnored(id, ignored, source);
    setScan((prev) =>
      prev
        ? {
          ...prev,
          groups: prev.groups.map((g) => ({
            ...g,
            sessions: g.sessions.map((s) => (s.claudeId === id && s.source === source ? { ...s, ignored } : s)),
          })),
        }
        : prev
    );
    if (ignored) setChecked((prev) => new Set([...prev].filter((x) => x !== id)));
  };

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submit = async () => {
    if (!scan || !checked.size || busy) return;
    setBusy(true);
    const items: ClaudeImportItem[] = scan.groups.flatMap((g) => {
      const clientPick = clients[g.repoPath] ?? g.suggestedClient;
      const client = clientPick === NEW_CLIENT ? newClients[g.repoPath]?.trim() || g.suggestedClient : clientPick;
      const picked = projects[g.repoPath] ?? AUTO_PROJECT;
      const project = picked === AUTO_PROJECT
        ? g.repoName
        : picked === NEW_PROJECT
        ? newProjects[g.repoPath]?.trim() || g.repoName
        : picked || null;
      return g.sessions.filter((s) => checked.has(s.claudeId)).map((s) => ({
        source: s.source,
        claudeId: s.claudeId,
        title: s.title,
        repoPath: s.repoPath,
        branch: s.branch,
        client,
        project,
        status: s.suggestedStatus,
        lastActive: s.lastActive,
      }));
    });
    try {
      const res = await runClaudeImport(items);
      onDone(res.imported);
    } finally {
      setBusy(false);
    }
  };

  const flat = scan?.groups.flatMap((g) => g.sessions) ?? [];
  const imported = flat.filter((s) => s.alreadyImported).length;
  const ignoredCount = flat.filter((s) => s.ignored && !s.alreadyImported).length;
  const newCount = flat.length - imported - ignoredCount;
  const matchesState = (s: ClaudeSession) =>
    stateFilter === "all"
      ? true
      : stateFilter === "imported"
      ? s.alreadyImported
      : stateFilter === "ignored"
      ? s.ignored && !s.alreadyImported
      : !s.alreadyImported && !s.ignored;
  const q = query.trim().toLowerCase();
  // a query matching the repo keeps the whole group; otherwise it narrows to matching titles
  const isVisible = (s: ClaudeSession, g: ClaudeGroup) =>
    matchesState(s) && (!q || g.repoName.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));

  return (
    <Modal width={720} onClose={onClose} onSubmit={submit}>
      <div className={label}>IMPORT FROM CLAUDE CODE + CODEX</div>
      <div className="flex items-center gap-1.5">
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            type="button"
            className={`rounded-md border px-2 py-1 text-[11.5px] ${
              days === d ? "border-copper text-copper" : "border-chipline text-ink-muted hover:text-ink-soft"
            }`}
            onClick={() => setDays(d)}
          >
            {d}d
          </button>
        ))}
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-muted">
          {scan ? `${scan.total} found` : "scanning…"}
          {q ? ` · “${query.trim()}”` : ""}
          {stateFilter !== "new" ? ` · ${stateFilter}` : ""}
        </span>
        <div className="relative">
          <button
            ref={filterBtn}
            type="button"
            title="Filter"
            className={`rounded-md border px-2 py-1 text-[11.5px] ${
              filterOpen || q || stateFilter !== "new"
                ? "border-copper text-copper"
                : "border-chipline text-ink-muted hover:text-ink-soft"
            }`}
            onClick={() => setFilterOpen((o) => !o)}
          >
            ▽
          </button>
          {filterOpen && (
            <Popover
              onClose={() => setFilterOpen(false)}
              className="flex w-64 flex-col gap-2 p-3"
              // fixed: the modal panel is a scroll container and clips absolute children
              style={filterBtn.current
                ? {
                  position: "fixed",
                  top: filterBtn.current.getBoundingClientRect().bottom + 6,
                  right: innerWidth - filterBtn.current.getBoundingClientRect().right,
                  left: "auto",
                  marginTop: 0,
                }
                : undefined}
            >
              <input
                autoFocus
                className={`${pill} w-full`}
                placeholder={scan ? `filter ${scan.total} sessions…` : "scanning…"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select
                value={stateFilter}
                className={`${pill} w-full text-left`}
                options={[
                  { value: "new", label: `new ${newCount}` },
                  { value: "imported", label: `imported ${imported}` },
                  { value: "ignored", label: `ignored ${ignoredCount}` },
                  { value: "all", label: `all ${flat.length}` },
                ]}
                onChange={(v) => setStateFilter(v as typeof stateFilter)}
              />
            </Popover>
          )}
        </div>
        {scan && newCount > 0 && (
          <button
            type="button"
            className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:text-ink-soft"
            onClick={() =>
              setChecked(
                checked.size ? new Set() : new Set(
                  scan.groups.flatMap((g) =>
                    g.sessions.filter((s) => isVisible(s, g) && !s.alreadyImported && !s.ignored).map((s) =>
                      s.claudeId
                    )
                  ),
                ),
              )}
          >
            {checked.size ? "Deselect all" : "Select all"}
          </button>
        )}
      </div>
      <div className="flex min-h-[120px] flex-col gap-3 overflow-y-auto">
        {scan && !scan.groups.length && (
          <div className="py-8 text-center text-[12.5px] text-ink-muted">
            No Claude Code or Codex sessions in the last {days} days.
          </div>
        )}
        {scan && scan.groups.length > 0 && !scan.groups.some((g) => g.sessions.some((s) => isVisible(s, g))) && (
          <div className="py-8 text-center text-[12.5px] text-ink-muted">
            {q ? `Nothing matches “${query.trim()}”.` : "Nothing here — switch the state filter to see imported or ignored sessions."}
          </div>
        )}
        {scan?.groups.map((g) => {
          const visible = g.sessions.filter((s) => isVisible(s, g));
          if (!visible.length) return null;
          const importable = g.sessions.filter((s) => !s.alreadyImported && !s.ignored);
          const allOn = importable.length > 0 && importable.every((s) => checked.has(s.claudeId));
          // only offer projects of the group's client (plus unassigned ones)
          const clientName = clients[g.repoPath] ?? g.suggestedClient;
          const clientId = board.projects.find((c) => c.name === clientName)?.id;
          const clientProjects = board.stories.filter((o) =>
            o.status !== "archived" && (!o.client_id || o.client_id === clientId)
          );
          // plain pages are offered too — the import promotes them on attach
          const clientPages = (board.pages ?? [])
            .filter((p) => p.kind !== "project" && (!p.client_id || p.client_id === clientId));
          return (
            <div key={g.repoPath} className="flex flex-col gap-1 rounded-lg border border-line bg-well p-2.5">
              <div className="flex items-center gap-2">
                <Check
                  on={allOn}
                  disabled={!importable.length}
                  onClick={() =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      for (const s of importable) allOn ? next.delete(s.claudeId) : next.add(s.claudeId);
                      return next;
                    })}
                />
                <span className="text-[12.5px] font-semibold text-ink">{g.repoName}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-muted/70">{g.repoPath}</span>
                <Select
                  value={clients[g.repoPath] ?? g.suggestedClient}
                  className={pill}
                  options={[
                    ...[...new Set([g.suggestedClient, ...board.projects.map((c) => c.name)])]
                      .map((c) => ({ value: c, label: c })),
                    { value: NEW_CLIENT, label: "＋ new client…" },
                  ]}
                  onChange={(v) => {
                    setClients((prev) => ({ ...prev, [g.repoPath]: v }));
                    // the picked project may not belong to the new client — back to auto
                    setProjects(({ [g.repoPath]: _, ...rest }) => rest);
                  }}
                />
                <Select
                  value={projects[g.repoPath] ?? AUTO_PROJECT}
                  className={pill}
                  options={[
                    { value: AUTO_PROJECT, label: `${g.repoName} (create)`, icon: "◇" },
                    ...clientProjects.map((o) => ({ value: o.title, label: o.title, icon: "◇" })),
                    ...clientPages.map((p) => ({ value: p.title, label: p.title, icon: "□" })),
                    { value: NEW_PROJECT, label: "＋ new story…" },
                    { value: "", label: "no story" },
                  ]}
                  onChange={(v) => setProjects((prev) => ({ ...prev, [g.repoPath]: v }))}
                />
              </div>
              {(clients[g.repoPath] ?? g.suggestedClient) === NEW_CLIENT && (
                <input
                  autoFocus
                  className={`${pill} ml-6 w-auto`}
                  placeholder="new client name (created on import)"
                  value={newClients[g.repoPath] ?? ""}
                  onChange={(e) => setNewClients((prev) => ({ ...prev, [g.repoPath]: e.target.value }))}
                />
              )}
              {(projects[g.repoPath] ?? AUTO_PROJECT) === NEW_PROJECT && (
                <input
                  autoFocus
                  className={`${pill} ml-6 w-auto`}
                  placeholder="new story title (created on import)"
                  value={newProjects[g.repoPath] ?? ""}
                  onChange={(e) => setNewProjects((prev) => ({ ...prev, [g.repoPath]: e.target.value }))}
                />
              )}
              {visible.map((s) => (
                <div
                  key={s.claudeId}
                  className={`group flex items-center gap-2 pl-6 text-[12px] ${
                    s.alreadyImported || s.ignored ? "opacity-40" : ""
                  }`}
                >
                  <Check
                    on={checked.has(s.claudeId)}
                    disabled={s.alreadyImported || s.ignored}
                    onClick={() => toggle(s.claudeId)}
                  />
                  <span className="w-11 shrink-0 rounded border border-chipline px-1 py-px text-center text-[9px] uppercase text-ink-muted">
                    {s.source}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-soft" title={s.title}>{s.title}</span>
                  {s.alreadyImported && (
                    <span className="rounded border border-chipline px-1.5 py-px text-[9.5px] text-ink-muted">
                      imported
                    </span>
                  )}
                  {s.ignored && !s.alreadyImported && (
                    <span className="rounded border border-chipline px-1.5 py-px text-[9.5px] text-ink-muted">
                      ignored
                    </span>
                  )}
                  {s.branch && <span className="shrink-0 text-[10.5px] text-ink-muted">⎇ {s.branch}</span>}
                  <span className="w-14 shrink-0 text-right text-[10.5px] text-ink-muted/80">
                    {timeAgo(s.lastActive)}
                  </span>
                  {!s.alreadyImported && (
                    <IconButton
                      className={`shrink-0 px-0.5 text-[11px] text-ink-muted hover:text-ink-soft ${
                        s.ignored ? "" : "opacity-0 group-hover:opacity-100"
                      }`}
                      title={s.ignored ? "Stop ignoring" : "Ignore this session"}
                      onClick={() => ignore(s.claudeId, s.source, !s.ignored)}
                    >
                      {s.ignored ? "↩" : "✕"}
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <Footer
        hint={`from ~/.claude/projects + ~/.codex/sessions on ${scan?.node ?? "this machine"} — never overwritten`}
        action={busy ? "Importing…" : `Import ${checked.size} session${checked.size === 1 ? "" : "s"}`}
        onClose={onClose}
        onSubmit={submit}
        disabled={busy || !checked.size}
      />
    </Modal>
  );
}
