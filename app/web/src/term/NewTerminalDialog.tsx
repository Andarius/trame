import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "../agents/agents";
import type { BoardData } from "../api";
import { TerminalIcon } from "../ui/icons";
import { EntityIcon, Modal, SECTION_LABEL, useLocalStorage } from "../ui/ui";
import { openTerminal, pickTermFolder, type TermAgent, termAgents } from "./term-api";

// the project's folders: its cards' repos, most recently touched first
export function projectFolders(board: BoardData | null, project: string): string[] {
  const cards = (board?.sessions ?? [])
    .filter((s) => s.client_id === project && s.repo_path)
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  return [...new Set(cards.map((s) => s.repo_path!.replace(/\/+$/, "")))].slice(0, 8);
}

const short = (path: string) => path.split("/").slice(-2).join("/");
const SHELL = "shell";
const STRING_CODEC = { parse: (r: string) => r, stringify: (v: string) => v };

// New terminal: what to run (a shell or an agent, the last pick preselected), then where (here, a project's
// folder, any folder). `project` narrows the folders to that project's; `onOpened` gets the shell's card.
export function NewTerminalDialog(
  { board, here, project, agent: preset, onClose, onOpened }: {
    board: BoardData | null;
    here?: { cwd: string | null; card: string | null } | null;
    project?: string;
    agent?: string; // preselect this agent's command instead of the last pick
    onClose: () => void;
    onOpened: (card: string | null) => void;
  },
) {
  const [agents, setAgents] = useState<TermAgent[] | null>(null);
  const [last, setLast] = useLocalStorage<string>("trame:termAgent", SHELL, STRING_CODEC);
  const [run, setRun] = useState(preset ?? last);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void termAgents().then(setAgents);
    list.current?.querySelector<HTMLButtonElement>("[data-choice]")?.focus({ preventScroll: true });
  }, []);
  const chosen = agents?.find((a) => a.command === run) ?? null;

  const open = async (cwd: string | null, card: string | null = null) => {
    try {
      await openTerminal(chosen ? { cwd, card, command: chosen.command, title: chosen.label } : { cwd, card });
      setLast(chosen ? chosen.command : SHELL);
      onOpened(card);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const other = async () => {
    const start = here?.cwd ?? (project ? projectFolders(board, project)[0] : null);
    const picked = await pickTermFolder(start).catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") return open(picked.replace(/\/+$/, ""));
    if ("error" in picked) setError(picked.error);
  };

  const projects = (board?.projects ?? [])
    .filter((p) => !project || p.id === project)
    .map((p) => ({ p, folders: projectFolders(board, p.id) }))
    .filter((x) => x.folders.length > 0);
  const choice = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-soft outline-none hover:bg-active-row hover:text-ink focus-visible:bg-active-row focus-visible:text-ink";
  const folder = (f: string, onClick = () => void open(f), label = short(f)) => (
    <button key={f} type="button" data-choice className={choice} title={f} onClick={onClick}>
      <span className="text-ink-muted"><TerminalIcon /></span>
      <span className="truncate">{label}</span>
      <span className="ml-auto max-w-[55%] truncate text-[11px] text-ink-faint">{f}</span>
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
            {chip(SHELL, "Shell", <span className="text-ink-muted"><TerminalIcon size={13} /></span>)}
            {agents?.map((a) => chip(a.command, a.label, <AgentIcon a={{ harness: a.command, icon: null }} />))}
            {agents === null && <span className="px-1 py-1 text-[11px] text-ink-faint">looking for agents…</span>}
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
            {here && !project &&
              folder(here.cwd ?? "~", () => void open(here.cwd, here.card), `Here · ${here.cwd ? short(here.cwd) : "~"}`)}
            {projects.map(({ p, folders }) => (
              <div key={p.id} className="flex flex-col">
                <div className={`flex items-center gap-1.5 px-2 pb-0.5 pt-2 ${SECTION_LABEL}`}>
                  {p.icon && <EntityIcon icon={p.icon} size={12} />}
                  {p.name.toUpperCase()}
                </div>
                {folders.map((f) => folder(f))}
              </div>
            ))}
            <div className="my-1 h-px bg-line" />
            <button type="button" data-choice className={choice} onClick={() => void other()}>
              <span className="w-3.5 text-center text-ink-muted">…</span>
              <span>Other folder…</span>
              <span className="ml-auto text-[11px] text-ink-faint">file manager dialog</span>
            </button>
          </div>
        </div>
        {error && <p className="text-[11.5px] text-blocked">{error}</p>}
      </div>
    </Modal>
  );
}
