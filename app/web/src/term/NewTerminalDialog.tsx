import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "../agents/agents";
import type { BoardData } from "../api";
import { TerminalIcon } from "../ui/icons";
import { EntityIcon, Modal, SECTION_LABEL, timeAgo, useLocalStorage } from "../ui/ui";
import { agentCmd } from "../agents/AgentSessions";
import { useScan } from "../agents/scan";
import { openTerminal, pickTermFolder, type TermAgent, termAgents, useTermSessions } from "./term-api";

// the project's folders: its cards' repos, most recently touched first
export function projectFolders(board: BoardData | null, project: string): string[] {
  const cards = (board?.sessions ?? [])
    .filter((s) => s.client_id === project && s.repo_path)
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  return [...new Set(cards.map((s) => s.repo_path!.replace(/\/+$/, "")))].slice(0, 8);
}

const short = (path: string) => path.split("/").slice(-2).join("/");
const FOLDERS_CODEC = {
  parse: (raw: string): Record<string, string> => {
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, string> : {};
    } catch {
      return {};
    }
  },
  stringify: (v: Record<string, string>) => JSON.stringify(v),
};
const SHELL = "shell";
const STRING_CODEC = { parse: (r: string) => r, stringify: (v: string) => v };

// New terminal: what to run (a shell or an agent), for which project, then where (here, the project's folders,
// any folder). Run and project start on the last picks; `project` (or here's) overrides the project.
// `onOpened` gets the new shell's card and project.
export function NewTerminalDialog(
  { board, here, project: presetProject, agent: preset, onClose, onOpened }: {
    board: BoardData | null;
    here?: { cwd: string | null; card: string | null; project?: string | null } | null;
    project?: string;
    agent?: string; // preselect this agent's command instead of the last pick
    onClose: () => void;
    onOpened: (card: string | null, project: string | null) => void;
  },
) {
  const [agents, setAgents] = useState<TermAgent[] | null>(null);
  const [last, setLast] = useLocalStorage<string>("trame:termAgent", SHELL, STRING_CODEC);
  const [run, setRun] = useState(preset ?? last);
  const hereProject = here?.card
    ? board?.sessions.find((s) => s.id === here.card)?.client_id ?? null
    : here?.project ?? null;
  const [lastProject, setLastProject] = useLocalStorage<string>("trame:termProject", "", STRING_CODEC);
  const known = (id: string | null | undefined) => (id && board?.projects.some((p) => p.id === id) ? id : null);
  const [project, setProject] = useState<string | null>(
    known(presetProject) ?? known(hereProject) ?? known(lastProject),
  );
  const [error, setError] = useState<string | null>(null);
  // the folder last opened per project ("" = none), preselected the next time
  const [lastFolders, setLastFolders] = useLocalStorage<Record<string, string>>("trame:termFolders", {}, FOLDERS_CODEC);
  const lastFolder = lastFolders[project ?? ""] ?? null;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => void termAgents().then(setAgents), []);
  useEffect(() => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-choice]") ?? [])];
    (all.find((b) => b.dataset.folder === lastFolder) ?? all[0])?.focus({ preventScroll: true });
  }, [project, lastFolder]);
  const chosen = agents?.find((a) => a.command === run) ?? null;

  const open = async (cwd: string | null, card: string | null = null) => {
    const owner = { cwd, card, project: card ? null : project };
    try {
      await openTerminal(chosen ? { ...owner, command: chosen.command, title: chosen.label } : owner);
      setLast(chosen ? chosen.command : SHELL);
      setLastProject(project ?? "");
      if (cwd) setLastFolders({ ...lastFolders, [project ?? ""]: cwd });
      onOpened(card, owner.project);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const other = async () => {
    const start = (project ? projectFolders(board, project)[0] : null) ?? here?.cwd;
    const picked = await pickTermFolder(start).catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") return open(picked.replace(/\/+$/, ""));
    if ("error" in picked) setError(picked.error);
  };

  const folders = project ? projectFolders(board, project) : [];
  // past sessions of the chosen agent in these folders, not running now: picked up with --resume
  const scan = useScan(7);
  const running = new Set(useTermSessions().map((x) => x.id));
  const source = chosen?.command.split(/\s/)[0].split("/").at(-1);
  const where = new Set([...folders, ...(project === null && here?.cwd ? [here.cwd] : [])].map((f) => f.replace(/\/+$/, "")));
  const resumable = source === "claude" || source === "codex"
    ? (scan?.groups ?? []).flatMap((g) => g.sessions)
      .filter((x) => x.source === source && !x.ignored && !running.has(x.claudeId))
      .filter((x) => x.repoPath && where.has(x.repoPath.replace(/\/+$/, "")))
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
      .slice(0, 5)
    : [];
  const resume = async (x: (typeof resumable)[number]) => {
    const card = board?.sessions.find((s) => s.id === x.claudeId || s.claude_id === x.claudeId)?.id ?? null;
    try {
      await openTerminal({ cwd: x.repoPath, card, project: card ? null : project, command: agentCmd(x), title: `${chosen!.label} · ${x.title}` });
      setLast(chosen!.command);
      onOpened(card, card ? null : project);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // here is offered when it belongs to the chosen project (or no project is chosen)
  const showHere = !!here && (project === null || project === hereProject);
  const choice = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-soft outline-none hover:bg-active-row hover:text-ink focus-visible:bg-active-row focus-visible:text-ink";
  const folder = (f: string, onClick = () => void open(f), label = short(f)) => (
    <button key={f} type="button" data-choice data-folder={f} className={choice} title={f} onClick={onClick}>
      <span className="text-ink-muted"><TerminalIcon /></span>
      <span className="truncate">{label}</span>
      <span className="ml-auto max-w-[55%] truncate text-[11px] text-ink-faint">{f}</span>
    </button>
  );
  const projectChip = (id: string | null, label: string, icon: React.ReactNode) => (
    <button
      key={id ?? "none"}
      type="button"
      aria-pressed={project === id}
      onClick={() => setProject(id)}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] ${
        project === id ? "border-copper/60 bg-copper/10 text-ink" : "border-line text-ink-muted hover:text-ink"
      }`}
    >
      {icon}
      {label}
    </button>
  );
  const chip = (key: string, label: string, icon: React.ReactNode) => (
    <button
      key={key}
      type="button"
      aria-pressed={run === key}
      onClick={() => setRun(key)}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] ${
        run === key ? "border-copper/60 bg-copper/10 text-ink" : "border-line text-ink-muted hover:text-ink"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Modal label="New terminal" width={480} onClose={onClose}>
      <div className="flex flex-col gap-4 p-1">
        <h2 className="text-[15px] font-semibold">New terminal</h2>
        <div className="flex flex-col gap-1.5">
          <div className={SECTION_LABEL}>RUN</div>
          <div className="flex flex-wrap gap-1.5">
            {chip(SHELL, "Shell", <span className="text-ink-muted"><TerminalIcon size={14} /></span>)}
            {agents?.map((a) => chip(a.command, a.label, <AgentIcon a={{ harness: a.command, icon: null }} />))}
            {agents === null && <span className="px-1 py-1 text-[11px] text-ink-faint">looking for agents…</span>}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={SECTION_LABEL}>PROJECT</div>
          <div className="flex flex-wrap gap-1.5">
            {projectChip(null, "None", null)}
            {(board?.projects ?? []).map((p) =>
              projectChip(p.id, p.name, p.icon ? <EntityIcon icon={p.icon} size={14} /> : null)
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={SECTION_LABEL}>IN</div>
          <div
            ref={list}
            className="flex max-h-[50vh] flex-col overflow-y-auto"
            // ↑↓ between the choices; Enter clicks the focused one
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const all = [...list.current!.querySelectorAll<HTMLButtonElement>("[data-choice]")];
              const i = all.indexOf(document.activeElement as HTMLButtonElement);
              all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus({ preventScroll: true });
            }}
          >
            {showHere &&
              folder(here!.cwd ?? "~", () => void open(here!.cwd, here!.card), `Here · ${here!.cwd ? short(here!.cwd) : "~"}`)}
            {folders.filter((f) => !(showHere && f === here!.cwd)).map((f) => folder(f))}
            {lastFolder && !(showHere && lastFolder === here!.cwd) && !folders.includes(lastFolder) &&
              folder(lastFolder, undefined, `Last · ${short(lastFolder)}`)}
            {(showHere || folders.length > 0) && <div className="my-1 h-px bg-line" />}
            <button type="button" data-choice className={choice} onClick={() => void other()}>
              <span className="w-3.5 text-center text-ink-muted">…</span>
              <span>Other folder…</span>
              <span className="ml-auto text-[11px] text-ink-faint">file manager dialog</span>
            </button>
          </div>
        </div>
        {resumable.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className={SECTION_LABEL}>RESUME</div>
            <div className="flex flex-col">
              {resumable.map((x) => (
                <button key={x.claudeId} type="button" className={choice} title={x.repoPath ?? undefined} onClick={() => void resume(x)}>
                  <span className="w-3.5 text-center text-ink-muted">↻</span>
                  <span className="min-w-0 flex-1 truncate">{x.title}</span>
                  {x.branch && <span className="max-w-[30%] truncate text-[11px] text-ink-faint">{x.branch}</span>}
                  <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(x.lastActive)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-[11.5px] text-blocked">{error}</p>}
      </div>
    </Modal>
  );
}
