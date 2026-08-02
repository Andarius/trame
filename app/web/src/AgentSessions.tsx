import { useEffect, useRef, useState } from "react";
import {
  type BoardData,
  type ClaudeScan,
  type ClaudeSession,
  resumeAllSessions,
  type ResumeMode,
  resumeSession,
  scanClaudeImport,
} from "./api";
import { Popover, timeAgo } from "./ui";

// Mirrors Drawer.tsx's resume affordance (same modes/labels), scoped to a single
// scanned session instead of a tracked Trame card — see api.ts's `local` param.
const RESUME_MODES: { mode: ResumeMode; label: string; hint: string }[] = [
  {
    mode: "window",
    label: "New window",
    hint: "opens a fresh terminal window",
  },
  { mode: "tab", label: "New tab", hint: "adds a tab to your open terminal" },
  {
    mode: "existing",
    label: "Existing session",
    hint: "types into your focused konsole",
  },
];
const RESUME_DONE: Record<ResumeMode, string> = {
  window: "terminal opened",
  tab: "tab opened",
  existing: "sent to terminal",
};

function SessionRow(
  { s, repoName, showRepo, card, onOpenSession }: {
    s: ClaudeSession;
    repoName: string;
    showRepo: boolean;
    card: { id: string } | undefined;
    onOpenSession: (id: string) => void;
  },
) {
  return (
    <div className="flex items-center gap-2 pl-2 text-[12px]">
      <span className="w-11 shrink-0 rounded border border-chipline px-1 py-px text-center text-[9px] uppercase text-ink-muted">
        {s.source}
      </span>
      <span
        className={`shrink-0 rounded px-1.5 py-px text-[9.5px] ${
          s.suggestedStatus === "active"
            ? "border border-chip-active-border bg-chip-active-bg text-active"
            : "border border-chipline text-ink-muted"
        }`}
      >
        {s.suggestedStatus === "active" ? "current" : "past"}
      </span>
      {showRepo && (
        <span className="w-32 shrink-0 truncate text-[10.5px] text-ink-muted">
          {repoName}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ink-soft" title={s.title}>
        {s.title}
      </span>
      {s.branch && (
        <span className="shrink-0 text-[10.5px] text-ink-muted">
          ⎇ {s.branch}
        </span>
      )}
      <span className="w-14 shrink-0 text-right text-[10.5px] text-ink-muted/80">
        {timeAgo(s.lastActive)}
      </span>
      {card && (
        <button
          type="button"
          title="Open the tracked card"
          onClick={() => onOpenSession(card.id)}
          className="shrink-0 whitespace-nowrap text-[10.5px] text-ink-muted hover:text-copper"
        >
          tracked ↗
        </button>
      )}
      <ResumeButton session={s} />
    </div>
  );
}

function ResumeButton({ session }: { session: ClaudeSession }) {
  const [mode, setMode] = useState<ResumeMode>(
    () =>
      (localStorage.getItem("trame:resumeMode") as ResumeMode | null) ??
        "window",
  );
  const [menu, setMenu] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!session.repoPath) return null;
  const repoPath = session.repoPath;

  const doResume = async (m: ResumeMode = mode) => {
    setMenu(false);
    setMode(m);
    localStorage.setItem("trame:resumeMode", m);
    let text: string;
    try {
      const r = await resumeSession(session.claudeId, m, {
        repoPath,
        agent: session.source,
      });
      if (r.launched) {
        text = RESUME_DONE[m];
      } else {
        try {
          await navigator.clipboard?.writeText(r.cmd);
        } catch { /* clipboard blocked — still show why below */ }
        text = r.reason === "api-disabled"
          ? "enable konsole D-Bus — copied"
          : "command copied";
      }
    } catch {
      text = "failed";
    }
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2500);
  };

  const active = RESUME_MODES.find((r) => r.mode === mode) ?? RESUME_MODES[0];
  return (
    <div className="relative flex shrink-0 items-center">
      <button
        type="button"
        title={`Resume in ${repoPath} — ${active.hint}`}
        onClick={() => doResume()}
        className="whitespace-nowrap rounded-l-md border border-r-0 border-chipline px-2 py-1 text-[11px] text-ink-muted hover:border-copper/60 hover:text-copper"
      >
        {msg ?? `Resume · ${active.label}`}
      </button>
      <button
        type="button"
        title="Resume mode"
        onClick={() => setMenu((v) => !v)}
        className="rounded-r-md border border-chipline px-1 py-1 text-[10px] text-ink-muted hover:border-copper/60 hover:text-copper"
      >
        ▾
      </button>
      {menu && (
        <Popover
          onClose={() => setMenu(false)}
          className="left-auto right-0 min-w-[220px]"
        >
          {RESUME_MODES.map((m) => (
            <button
              type="button"
              key={m.mode}
              onClick={() => doResume(m.mode)}
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-panel"
            >
              <span className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                {m.label}
                {m.mode === mode && (
                  <span className="text-[10px] text-copper">✓</span>
                )}
              </span>
              <span className="text-[10.5px] text-ink-muted">{m.hint}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

// Browse Claude Code + Codex transcripts found on this machine — current (touched
// recently) and past — with a one-click Resume, independent of whether the session
// has ever been tracked as a Trame board card. Mainly useful right after a reboot,
// when every terminal (and with it, the memory of what was open) is gone.
export function AgentSessions(
  { board, onOpenSession }: {
    board: BoardData;
    onOpenSession: (id: string) => void;
  },
) {
  const [days, setDays] = useState(7);
  const [scan, setScan] = useState<ClaudeScan | null>(null);
  const [statusFilter, setStatusFilter] = useState<"active" | "paused" | "all">(
    "all",
  );
  const [sortBy, setSortBy] = useState<"date" | "repo">("date");
  const [q, setQ] = useState("");
  const [allMsg, setAllMsg] = useState<string | null>(null);
  const allTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(allTimer.current), []);

  const load = () => {
    setScan(null);
    scanClaudeImport(days).then(setScan);
  };
  useEffect(load, [days]);

  const query = q.trim().toLowerCase();
  const isVisible = (s: ClaudeSession, repoName: string) =>
    (statusFilter === "all" || s.suggestedStatus === statusFilter) &&
    (!query ||
      repoName.toLowerCase().includes(query) ||
      s.title.toLowerCase().includes(query));

  // an imported (or /trame:track-created) card carries this transcript's uuid as
  // its own id, or in the legacy claude_id column — either way, jump straight to it
  const cardFor = (s: ClaudeSession) =>
    board.sessions.find((row) =>
      row.id === s.claudeId || row.claude_id === s.claudeId
    );

  // everything currently visible and resumable — what "Resume all" launches
  const visibleAll = (scan?.groups ?? []).flatMap((g) =>
    g.sessions.filter((s) => isVisible(s, g.repoName) && s.repoPath)
  );
  const resumeAll = async () => {
    if (!visibleAll.length) return;
    let msg: string;
    try {
      const r = await resumeAllSessions(
        visibleAll.map((s) => ({
          id: s.claudeId,
          repoPath: s.repoPath as string,
          agent: s.source,
        })),
      );
      msg = r.ok
        ? r.mode === "konsole-tabs"
          ? `${r.launched} tabs opened`
          : `${r.launched} windows opened`
        : r.error ?? "failed";
    } catch {
      msg = "failed";
    }
    setAllMsg(msg);
    clearTimeout(allTimer.current);
    allTimer.current = setTimeout(() => setAllMsg(null), 2500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-6 py-2.5">
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            type="button"
            className={`rounded-md border px-2 py-1 text-[11.5px] ${
              days === d
                ? "border-copper text-copper"
                : "border-chipline text-ink-muted hover:text-ink-soft"
            }`}
            onClick={() => setDays(d)}
          >
            {d}d
          </button>
        ))}
        <div className="ml-1 flex rounded-[7px] bg-panel p-[3px]">
          {(["all", "active", "paused"] as const).map((f) => (
            <button
              type="button"
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11px] ${
                statusFilter === f
                  ? "bg-tab-active font-medium text-ink"
                  : "text-ink-muted hover:text-ink-soft"
              }`}
            >
              {f === "all" ? "all" : f === "active" ? "current" : "past"}
            </button>
          ))}
        </div>
        <div className="flex rounded-[7px] bg-panel p-[3px]">
          {(["date", "repo"] as const).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setSortBy(s)}
              title={s === "date" ? "Sort by last activity" : "Group by repo"}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11px] capitalize ${
                sortBy === s
                  ? "bg-tab-active font-medium text-ink"
                  : "text-ink-muted hover:text-ink-soft"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          className="ml-1 min-w-0 flex-1 rounded-md border border-chipline bg-transparent px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-ink-muted/60 focus:border-copper/50"
          placeholder={scan ? `filter ${scan.total} sessions…` : "scanning…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="button"
          title="Resume every visible session — konsole gets one window with a tab per session, ghostty one window each"
          onClick={resumeAll}
          disabled={!visibleAll.length}
          className="shrink-0 whitespace-nowrap rounded-md border border-chipline px-2 py-1 text-[11.5px] text-ink-muted hover:border-copper/60 hover:text-copper disabled:opacity-50"
        >
          {allMsg ?? `⇪ Resume all · ${visibleAll.length}`}
        </button>
        <button
          type="button"
          title="Rescan"
          onClick={load}
          className="shrink-0 rounded-md border border-chipline px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
        >
          ↻
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!scan && <p className="text-[12.5px] text-ink-muted">Scanning…</p>}
        {scan && !scan.groups.length && (
          <p className="py-8 text-center text-[12.5px] text-ink-muted">
            No Claude Code or Codex sessions in the last {days} days.
          </p>
        )}
        {scan && sortBy === "repo" && scan.groups.map((g) => {
          const visible = g.sessions.filter((s) => isVisible(s, g.repoName));
          if (!visible.length) return null;
          return (
            <div
              key={g.repoPath}
              className="mb-3 flex flex-col gap-1 rounded-lg border border-line bg-well p-2.5"
            >
              <div className="flex items-baseline gap-2 px-1 pb-0.5">
                <span className="text-[12.5px] font-medium text-ink-soft">
                  {g.repoName}
                </span>
                <span className="min-w-0 truncate text-[10.5px] text-ink-muted">
                  {g.repoPath}
                </span>
              </div>
              {visible.map((s) => (
                <SessionRow
                  key={s.claudeId}
                  s={s}
                  repoName={g.repoName}
                  showRepo={false}
                  card={cardFor(s)}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          );
        })}
        {scan && sortBy === "date" && (() => {
          const flat = scan.groups
            .flatMap((g) =>
              g.sessions
                .filter((s) => isVisible(s, g.repoName))
                .map((s) => ({ s, repoName: g.repoName }))
            )
            .sort((a, b) => b.s.lastActive.localeCompare(a.s.lastActive));
          if (!flat.length && scan.groups.length) {
            return (
              <p className="py-8 text-center text-[12.5px] text-ink-muted">
                Nothing matches the current filter.
              </p>
            );
          }
          return (
            <div className="flex flex-col gap-1 rounded-lg border border-line bg-well p-2.5">
              {flat.map(({ s, repoName }) => (
                <SessionRow
                  key={s.claudeId}
                  s={s}
                  repoName={repoName}
                  showRepo
                  card={cardFor(s)}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
