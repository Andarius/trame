import { useEffect, useRef, useState } from "react";
import {
  type BoardData,
  type ClaudeScan,
  type ClaudeSession,
  scanClaudeImport,
} from "./api";
import { clientColor, Select, timeAgo } from "./ui";

// This view never launches terminals (unlike Drawer.tsx's tracked-card resume) —
// it just hands you the command to paste. Same shape as main.ts's resume cmd.
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`; // POSIX single-quote
const resumeCmd = (s: ClaudeSession) => {
  const cmd = s.source === "codex"
    ? `codex resume ${s.claudeId}`
    : `claude --resume ${s.claudeId}`;
  return s.repoPath ? `cd ${shq(s.repoPath)} && ${cmd}` : cmd;
};

// Brand marks (Simple Icons paths, 24×24); unknown agents fall back to their
// initial so a new source stays identifiable before it gets an icon here.
const CLAUDE_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const SOURCE_ICONS: Record<string, { path: string; color: string }> = {
  claude: { path: CLAUDE_PATH, color: "#d97757" },
  codex: { path: OPENAI_PATH, color: "currentColor" }, // OpenAI mark is monochrome — follow the theme
};

function SourceIcon(
  { source, onClick }: { source: string; onClick: () => void },
) {
  const icon = SOURCE_ICONS[source];
  return (
    <button
      type="button"
      title={`${source} — click to filter`}
      onClick={onClick}
      className="flex w-4 shrink-0 items-center justify-center text-ink-soft hover:brightness-125"
    >
      {icon
        ? (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill={icon.color}>
            <path d={icon.path} />
          </svg>
        )
        : (
          <span className="text-[10px] font-medium text-ink-muted">
            {source[0]?.toUpperCase() ?? "?"}
          </span>
        )}
    </button>
  );
}

function SessionRow(
  {
    s,
    repoName,
    repoColor,
    showRepo,
    card,
    onOpenSession,
    onFilterRepo,
    onFilterStatus,
    onFilterSource,
  }: {
    s: ClaudeSession;
    repoName: string;
    repoColor: string;
    showRepo: boolean;
    card: { id: string } | undefined;
    onOpenSession: (id: string) => void;
    onFilterRepo: () => void;
    onFilterStatus: () => void;
    onFilterSource: () => void;
  },
) {
  return (
    <div className="flex items-center gap-2 pl-2 text-[12px]">
      <SourceIcon source={s.source} onClick={onFilterSource} />
      <button
        type="button"
        onClick={onFilterStatus}
        title={s.suggestedStatus === "active"
          ? "Touched in the last 48 h — click to filter"
          : "Idle for more than 48 h — click to filter"}
        className={`shrink-0 rounded px-1.5 py-px text-[9.5px] hover:brightness-125 ${
          s.suggestedStatus === "active"
            ? "border border-chip-active-border bg-chip-active-bg text-active"
            : "border border-chipline text-ink-muted"
        }`}
      >
        {s.suggestedStatus === "active" ? "current" : "past"}
      </button>
      {showRepo && (
        <button
          type="button"
          title={`Filter on ${repoName}`}
          onClick={onFilterRepo}
          className="flex w-32 shrink-0 items-center gap-1.5 hover:brightness-125"
        >
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: repoColor }}
          />
          <span className="truncate text-[10.5px]" style={{ color: repoColor }}>
            {repoName}
          </span>
        </button>
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
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!session.repoPath) return null;
  const cmd = resumeCmd(session);

  const copy = async () => {
    let text: string;
    try {
      await navigator.clipboard.writeText(cmd);
      text = "copied";
    } catch {
      text = "clipboard blocked";
    }
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2500);
  };

  return (
    <button
      type="button"
      title={`Copy to clipboard: ${cmd}`}
      onClick={copy}
      className="shrink-0 whitespace-nowrap rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:border-copper/60 hover:text-copper"
    >
      {msg ?? "⧉ Copy resume"}
    </button>
  );
}

// Browse Claude Code + Codex transcripts found on this machine — current (touched
// recently) and past — with one-click copy of the resume command, independent of
// whether the session has ever been tracked as a Trame board card. Mainly useful
// right after a reboot, when every terminal (and the memory of what was open) is gone.
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
  const [sourceFilter, setSourceFilter] = useState("all");
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

  // every agent found by the scan — the picker adapts as new sources appear
  const sources: string[] = [
    ...new Set(
      (scan?.groups ?? []).flatMap((g) => g.sessions.map((s) => s.source)),
    ),
  ].sort();
  useEffect(() => {
    if (scan && sourceFilter !== "all" && !sources.includes(sourceFilter)) {
      setSourceFilter("all");
    }
  }, [scan]);

  const query = q.trim().toLowerCase();
  const isVisible = (s: ClaudeSession, repoName: string) =>
    (statusFilter === "all" || s.suggestedStatus === statusFilter) &&
    (sourceFilter === "all" || s.source === sourceFilter) &&
    (!query ||
      repoName.toLowerCase().includes(query) ||
      s.title.toLowerCase().includes(query));

  // an imported (or /trame:track-created) card carries this transcript's uuid as
  // its own id, or in the claude_id column — either way, jump straight to it
  const cardFor = (s: ClaudeSession) =>
    board.sessions.find((row) =>
      row.id === s.claudeId || row.claude_id === s.claudeId
    );

  // tracked project's color when the repo name matches one, hash fallback otherwise
  const repoColor = (repoName: string) =>
    clientColor(
      repoName,
      board.projects.find((p) => p.name === repoName)?.color,
    );

  // click a project name / status badge / AI icon → filter on it (click again to clear)
  const toggleRepoFilter = (name: string) =>
    setQ((cur) => (cur === name ? "" : name));
  const toggleStatusFilter = (status: "active" | "paused") =>
    setStatusFilter((cur) => (cur === status ? "all" : status));
  const toggleSourceFilter = (source: string) =>
    setSourceFilter((cur) => (cur === source ? "all" : source));

  // everything currently visible and resumable — what "Copy all" copies
  const visibleAll = (scan?.groups ?? []).flatMap((g) =>
    g.sessions.filter((s) => isVisible(s, g.repoName) && s.repoPath)
  );
  const copyAll = async () => {
    if (!visibleAll.length) return;
    let msg: string;
    try {
      await navigator.clipboard.writeText(
        visibleAll.map(resumeCmd).join("\n"),
      );
      msg = `${visibleAll.length} copied`;
    } catch {
      msg = "clipboard blocked";
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
              title={f === "active"
                ? "Sessions touched in the last 48 h"
                : f === "paused"
                ? "Sessions idle for more than 48 h"
                : undefined}
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
        <div className="w-28 shrink-0">
          <Select
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[
              { value: "all", label: "all AIs" },
              ...sources.map((s) => ({ value: s, label: s })),
            ]}
            className="rounded-md border border-chipline bg-transparent px-2 py-1 text-[11px] text-ink-muted outline-none hover:text-ink-soft focus:border-copper/50"
          />
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
          title="Copy the resume command of every visible session, one per line"
          onClick={copyAll}
          disabled={!visibleAll.length}
          className="shrink-0 whitespace-nowrap rounded-md border border-chipline px-2 py-1 text-[11.5px] text-ink-muted hover:border-copper/60 hover:text-copper disabled:opacity-50"
        >
          {allMsg ?? `⧉ Copy all · ${visibleAll.length}`}
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
                <button
                  type="button"
                  title={`Filter on ${g.repoName}`}
                  onClick={() => toggleRepoFilter(g.repoName)}
                  className="flex items-center gap-2 hover:brightness-125"
                >
                  <span
                    className="h-[8px] w-[8px] shrink-0 rounded-full"
                    style={{ background: repoColor(g.repoName) }}
                  />
                  <span className="text-[12.5px] font-medium text-ink-soft">
                    {g.repoName}
                  </span>
                </button>
                <span className="min-w-0 truncate text-[10.5px] text-ink-muted">
                  {g.repoPath}
                </span>
              </div>
              {visible.map((s) => (
                <SessionRow
                  key={s.claudeId}
                  s={s}
                  repoName={g.repoName}
                  repoColor={repoColor(g.repoName)}
                  showRepo={false}
                  card={cardFor(s)}
                  onOpenSession={onOpenSession}
                  onFilterRepo={() => toggleRepoFilter(g.repoName)}
                  onFilterStatus={() => toggleStatusFilter(s.suggestedStatus)}
                  onFilterSource={() => toggleSourceFilter(s.source)}
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
                  repoColor={repoColor(repoName)}
                  showRepo
                  card={cardFor(s)}
                  onOpenSession={onOpenSession}
                  onFilterRepo={() => toggleRepoFilter(repoName)}
                  onFilterStatus={() => toggleStatusFilter(s.suggestedStatus)}
                  onFilterSource={() => toggleSourceFilter(s.source)}
                />
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
