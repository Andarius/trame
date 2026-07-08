import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  applyUpdate,
  type BoardData,
  type ClaudeGroup,
  type ClaudeImportItem,
  type ClaudeScan,
  type ClaudeSession,
  getSettings,
  getUpdate,
  openInBrowser,
  patchSettings,
  runClaudeImport,
  scanClaudeImport,
  setClaudeIgnored,
  type Status,
  type UpdateInfo,
} from "./api";
import { pageOptions, Popover, Select, STATUS, StatusDot, timeAgo } from "./ui";

function Modal(
  { width = 560, onClose, onSubmit, children }: {
    width?: number;
    onClose: () => void;
    onSubmit: () => void;
    children: ReactNode;
  },
) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose, onSubmit]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[16vh]" onClick={onClose}>
      <div
        className="flex max-h-[76vh] flex-col gap-3 overflow-y-auto rounded-xl border border-[#323649] bg-[#171923] p-5 shadow-2xl shadow-black/50"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const label = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/80";
const input =
  "w-full bg-transparent outline-none placeholder:text-ink-muted/50 border-none p-0 text-ink";
const STORY_PLACEHOLDER = "The story — why this matters.\n\nDone when:\n·  …\n·  …";
const pill =
  "appearance-none rounded-md border border-chipline bg-transparent px-2 py-1 text-[11.5px] text-ink-soft outline-none";

function Footer(
  { hint, action, onClose, onSubmit, disabled }: {
    hint: string;
    action: string;
    onClose: () => void;
    onSubmit: () => void;
    disabled: boolean;
  },
) {
  return (
    <>
      <div className="h-px bg-line" />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[10.5px] text-ink-muted/85">{hint}</span>
        <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
          Cancel
        </button>
        <button type="button"
          className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink disabled:opacity-40"
          onClick={onSubmit}
          disabled={disabled}
        >
          {action} <span className="text-[10.5px] opacity-70">⌘↵</span>
        </button>
      </div>
    </>
  );
}

export function NewSessionModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (s: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [client, setClient] = useState(board.clients[0]?.name ?? "");
  const [objective, setObjective] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [branch, setBranch] = useState("");
  const [nextStep, setNextStep] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      status,
      client: client || undefined,
      // an existing pick is a page id (plain pages get promoted); __new__ is a title
      ...(objective === "__new__" ? { objective: newObjective || undefined } : { page_id: objective || undefined }),
      branch: branch || undefined,
      next_step: nextStep || undefined,
    });
  };

  return (
    <Modal onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW SESSION</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="repo — short topic"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded-md border border-chipline py-1 pl-2 pr-1">
          <StatusDot status={status} size={7} />
          <Select
            value={status}
            className="bg-transparent px-1 text-[11.5px] text-ink-soft outline-none"
            options={Object.entries(STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
            onChange={(v) => setStatus(v as Status)}
          />
        </span>
        <Select
          value={client}
          className={pill}
          options={board.clients.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
        <Select
          value={objective}
          className={pill}
          options={[
            { value: "", label: "◎ no project" },
            ...pageOptions(board.objectives, board.pages ?? []),
            { value: "__new__", label: "＋ new project…" },
          ]}
          onChange={setObjective}
        />
        <input
          className={`${pill} w-36`}
          placeholder="⎇ branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      {objective === "__new__" && (
        <input
          className={`${pill} w-full`}
          placeholder="new project title (created on save)"
          value={newObjective}
          onChange={(e) => setNewObjective(e.target.value)}
        />
      )}
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-ink-soft">→</span>
        <input
          className={`${input} text-[12.5px]`}
          placeholder="next step (imperative, one line)"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
        />
      </div>
      <Footer
        hint="/project:track fills all of this automatically from a repo"
        action="Create session"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}

function PathList(
  { items, onChange, placeholder, addLabel }: {
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
    addLabel: string;
  },
) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            className={`${pill} w-full`}
            value={p}
            autoFocus={i === items.length - 1 && p === ""}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => j === i ? e.target.value : x))}
          />
          <button type="button"
            className="px-1 text-ink-muted hover:text-blocked"
            title="remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button"
        className="w-fit rounded-md px-1 py-0.5 text-[11.5px] text-ink-muted hover:text-ink-soft"
        onClick={() => onChange([...items, ""])}
      >
        {addLabel}
      </button>
    </div>
  );
}

export function SettingsModal(
  { onClose, onSaved }: { onClose: () => void; onSaved: () => void },
) {
  const [paths, setPaths] = useState<string[]>([]);
  const [ignore, setIgnore] = useState<string[]>([]);
  const [source, setSource] = useState<"settings" | "env">("settings");
  const [loaded, setLoaded] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updState, setUpdState] = useState<"idle" | "busy" | "done">("idle");

  useEffect(() => {
    getSettings().then((s) => {
      setPaths(s.paths.length ? s.paths : [""]);
      setIgnore(s.ignore ?? []);
      setSource(s.source);
      setLoaded(true);
    }).catch(() => setLoaded(true));
    getUpdate().then((u) => {
      setUpdate(u);
      if (u.applied) setUpdState("done");
    }).catch(() => {});
  }, []);

  const runUpdate = () => {
    if (!update) return;
    if (!update.canSelfUpdate) {
      openInBrowser(update.releaseUrl);
      return;
    }
    if (updState !== "idle") return;
    setUpdState("busy");
    applyUpdate().then((r) => setUpdState(r.ok ? "done" : "idle")).catch(() => setUpdState("idle"));
  };

  const submit = () =>
    patchSettings({
      reportPaths: paths.map((p) => p.trim()).filter(Boolean),
      ignorePaths: ignore.map((p) => p.trim()).filter(Boolean),
    }).then(() => {
      onSaved();
      onClose();
    });

  return (
    <Modal width={620} onClose={onClose} onSubmit={submit}>
      <div className={label}>SETTINGS</div>

      <div className="text-[12.5px] font-semibold">Updates</div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-soft">Trame v{update?.current ?? "…"}</span>
        {update?.available
          ? (
            <>
              <span className="rounded bg-copper/15 px-1.5 py-0.5 text-[10.5px] font-medium text-copper">
                v{update.latest} available
              </span>
              <button
                type="button"
                className="text-[10.5px] text-ink-muted underline decoration-chipline underline-offset-2 hover:text-ink-soft"
                onClick={() => update && openInBrowser(update.releaseUrl)}
              >
                release notes
              </button>
              <span className="flex-1" />
              {updState === "done"
                ? <span className="text-[11px]" style={{ color: "var(--color-active)" }}>✓ updated — restart Trame</span>
                : (
                  <button
                    type="button"
                    className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-60"
                    disabled={updState === "busy"}
                    onClick={runUpdate}
                  >
                    {updState === "busy" ? "Updating…" : update.canSelfUpdate ? "Update now" : "Open release"}
                  </button>
                )}
            </>
          )
          : update?.applied
          ? <span className="text-[11px]" style={{ color: "var(--color-active)" }}>✓ updated — restart Trame</span>
          : update && <span className="text-[11px] text-ink-muted/70">· up to date</span>}
      </div>

      <div className="h-px bg-line" />
      <button
        type="button"
        className="flex items-center gap-2 text-left text-[12.5px] font-semibold text-ink hover:text-copper"
        onClick={() => setExploreOpen((v) => !v)}
      >
        <span className="text-[9px] text-ink-muted">{exploreOpen ? "▾" : "▸"}</span>
        Explore — report folders
        <span className="text-[10.5px] font-normal text-ink-muted/70">
          {paths.filter(Boolean).length} folder{paths.filter(Boolean).length === 1 ? "" : "s"} · {ignore.filter(Boolean).length} ignored
        </span>
      </button>
      {exploreOpen && (
        <>
          <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
            Folders scanned (4 levels deep) for <code>.html</code> exploration reports. Searchable in
            the Explore view alongside published reports.
            {source === "env" && " Currently coming from TRACKER_REPORT_PATHS — saving here takes over."}
          </p>
          {loaded && (
            <PathList
              items={paths}
              onChange={setPaths}
              placeholder="~/Projects or /absolute/path"
              addLabel="＋ Add folder"
            />
          )}
          <div className="pt-1 text-[12.5px] font-semibold">Ignore</div>
          <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
            A folder <em>name</em> (<code>htmlcov</code> ≡ <code>**/htmlcov</code>) ignores it anywhere;
            a <em>path</em> (<code>~/Projects/x/devops</code>) ignores that subtree; <em>globs</em> work
            too (<code>~/Projects/**/coverage</code>, <code>**/*.min.html</code>).{" "}
            <code>node_modules</code>, <code>.git</code>, <code>dist</code>… are always ignored.
          </p>
          {loaded && (
            <PathList
              items={ignore}
              onChange={setIgnore}
              placeholder="externals — or ~/path/to/skip"
              addLabel="＋ Add ignore"
            />
          )}
        </>
      )}
      <Footer
        hint="stored per-machine in settings.json (not synced)"
        action="Save settings"
        onClose={onClose}
        onSubmit={submit}
        disabled={!loaded}
      />
    </Modal>
  );
}

export function NewUdbModal(
  { onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void },
) {
  const [name, setName] = useState("");
  const submit = () => name.trim() && onCreate(name.trim());
  return (
    <Modal width={440} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW DATABASE</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="e.g. Benchmarks, Metrics log…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <Footer
        hint="columns are added from the table's “+” header cell"
        action="Create database"
        onClose={onClose}
        onSubmit={submit}
        disabled={!name.trim()}
      />
    </Modal>
  );
}

export function NewObjectiveModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (o: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [client, setClient] = useState(board.clients[0]?.name ?? "");
  const [story, setStory] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({ title: title.trim(), client: client || undefined, story });
  };

  return (
    <Modal width={720} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW PROJECT</div>
      <input
        autoFocus
        className={`${input} text-xl font-semibold`}
        placeholder="What are we trying to achieve?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="w-56">
        <Select
          value={client}
          className={pill}
          options={board.clients.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-[#101219] p-3">
        <textarea
          className={`${input} min-h-[190px] resize-none text-[13px] leading-relaxed`}
          placeholder={STORY_PLACEHOLDER}
          value={story}
          onChange={(e) => setStory(e.target.value)}
        />
        <span className="text-[10.5px] text-ink-muted/80">
          The story — what are we trying to achieve? Sessions ladder up here.
        </span>
      </div>
      <Footer
        hint="projects are also created automatically by /project:track"
        action="Create project"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}

const AUTO_PROJECT = "__auto__";
const NEW_PROJECT = "__new__";
const NEW_CLIENT = "__new_client__";

function Check({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] transition-colors disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className={`flex h-full w-full items-center justify-center rounded ${
          on ? "border-copper bg-copper text-copper-ink" : "border border-chipline text-transparent"
        }`}
      >
        ✓
      </span>
    </button>
  );
}

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

  const ignore = (id: string, ignored: boolean) => {
    setClaudeIgnored(id, ignored);
    setScan((prev) =>
      prev
        ? {
          ...prev,
          groups: prev.groups.map((g) => ({
            ...g,
            sessions: g.sessions.map((s) => (s.claudeId === id ? { ...s, ignored } : s)),
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
      <div className={label}>IMPORT FROM CLAUDE CODE</div>
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
            No Claude Code sessions in the last {days} days.
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
          const clientId = board.clients.find((c) => c.name === clientName)?.id;
          const clientProjects = board.objectives.filter((o) => !o.client_id || o.client_id === clientId);
          // plain pages are offered too — the import promotes them on attach
          const clientPages = (board.pages ?? [])
            .filter((p) => p.kind !== "project" && (!p.client_id || p.client_id === clientId));
          return (
            <div key={g.repoPath} className="flex flex-col gap-1 rounded-lg border border-line bg-[#101219] p-2.5">
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
                    ...[...new Set([g.suggestedClient, ...board.clients.map((c) => c.name)])]
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
                    { value: AUTO_PROJECT, label: `◎ ${g.repoName} (create)` },
                    ...clientProjects.map((o) => ({ value: o.title, label: `◎ ${o.title}` })),
                    ...clientPages.map((p) => ({ value: p.title, label: `□ ${p.title}` })),
                    { value: NEW_PROJECT, label: "＋ new project…" },
                    { value: "", label: "no project" },
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
                  placeholder="new project title (created on import)"
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
                    <button
                      type="button"
                      className={`shrink-0 px-0.5 text-[11px] text-ink-muted hover:text-ink-soft ${
                        s.ignored ? "" : "opacity-0 group-hover:opacity-100"
                      }`}
                      title={s.ignored ? "Stop ignoring" : "Ignore this session"}
                      onClick={() => ignore(s.claudeId, !s.ignored)}
                    >
                      {s.ignored ? "↩" : "✕"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <Footer
        hint={`from ~/.claude/projects on ${scan?.node ?? "this machine"} — existing cards are never overwritten`}
        action={busy ? "Importing…" : `Import ${checked.size} session${checked.size === 1 ? "" : "s"}`}
        onClose={onClose}
        onSubmit={submit}
        disabled={busy || !checked.size}
      />
    </Modal>
  );
}
