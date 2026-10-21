import { useState } from "react";
import type { BoardData } from "../api";
import { TerminalIcon } from "../ui/icons";
import { EntityIcon, IconButton, MenuRow, Popover, SECTION_LABEL } from "../ui/ui";
import { openTerminal, pickTermFolder } from "./term-api";

// the project's folders: its cards' repos, most recently touched first
export function projectFolders(board: BoardData | null, project: string): string[] {
  const cards = (board?.sessions ?? [])
    .filter((s) => s.client_id === project && s.repo_path)
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  return [...new Set(cards.map((s) => s.repo_path!.replace(/\/+$/, "")))].slice(0, 8);
}

const short = (path: string) => path.split("/").slice(-2).join("/");

// Where a new shell opens: here (the current card's folder), a project's folder, or any folder.
// `project` narrows the list to that project's folders; `onOpened` gets the new shell's card.
export function FolderChoices(
  { board, here, project, onOpened }: {
    board: BoardData | null;
    here?: { cwd: string | null; card: string | null } | null;
    project?: string;
    onOpened: (card: string | null) => void;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = async (cwd: string | null, card: string | null = null) => {
    try {
      await openTerminal({ cwd, card });
      onOpened(card);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const other = async () => {
    const picked = await pickTermFolder().catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") return open(picked.replace(/\/+$/, ""));
    if ("error" in picked) setError(picked.error);
  };
  const folderRow = (f: string, indent = false) => (
    <MenuRow key={f} title={f} className={indent ? "pl-6" : ""} onClick={() => void open(f)}>
      <span className="text-ink-muted"><TerminalIcon /></span>
      <span className="min-w-0 flex-1 truncate">{short(f)}</span>
    </MenuRow>
  );
  const projects = project ? [] : (board?.projects ?? [])
    .map((p) => ({ p, folders: projectFolders(board, p.id) }))
    .filter((x) => x.folders.length > 0);
  return (
    <>
      <div className={`px-2 pb-1 pt-0.5 ${SECTION_LABEL}`}>NEW TERMINAL IN</div>
      {here && (
        <MenuRow title={here.cwd ?? "home folder"} onClick={() => void open(here.cwd, here.card)}>
          <span className="text-ink-muted"><TerminalIcon /></span>
          <span className="min-w-0 flex-1 truncate">Here · {here.cwd ? short(here.cwd) : "~"}</span>
          <span className="text-[10px] text-ink-faint">⌘T</span>
        </MenuRow>
      )}
      {project && projectFolders(board, project).map((f) => folderRow(f))}
      {projects.length > 0 && <div className={`px-2 pb-1 pt-2 ${SECTION_LABEL}`}>PROJECTS</div>}
      {projects.map(({ p, folders }) => (
        <div key={p.id}>
          <div className="flex items-center">
            <MenuRow title={folders[0]} className="min-w-0 flex-1" onClick={() => void open(folders[0])}>
              <span className="grid w-3.5 place-items-center">{p.icon ? <EntityIcon icon={p.icon} size={13} /> : "◇"}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="max-w-[110px] truncate text-[10.5px] text-ink-faint">{short(folders[0])}</span>
            </MenuRow>
            {folders.length > 1 && (
              <IconButton
                tone="close"
                className="px-1.5"
                aria-label={`${p.name} folders`}
                aria-expanded={expanded === p.id}
                onClick={() => setExpanded((x) => (x === p.id ? null : p.id))}
              >
                {expanded === p.id ? "▾" : "▸"}
              </IconButton>
            )}
          </div>
          {expanded === p.id && folders.map((f) => folderRow(f, true))}
        </div>
      ))}
      <div className="my-1 h-px bg-line" />
      <MenuRow onClick={() => void other()}>
        <span className="w-3.5 text-center text-ink-muted">…</span>
        <span className="flex-1">Other folder…</span>
      </MenuRow>
      {error && <p className="max-w-[260px] px-2 py-1 text-[11px] leading-snug text-blocked">{error}</p>}
    </>
  );
}

// Right-click menu on a project in the Terminals column: a new shell in one of its folders, or any folder.
export function ProjectTermMenu(
  { board, project, onClose, onOpened }: {
    board: BoardData | null;
    project: string;
    onClose: () => void;
    onOpened: () => void;
  },
) {
  return (
    <Popover portal onClose={onClose}>
      <FolderChoices
        board={board}
        project={project}
        onOpened={() => {
          onOpened();
          onClose();
        }}
      />
    </Popover>
  );
}
