import { useEffect, useState } from "react";
import { addRepo, type BoardData, type ProjectRepo, removeRepo, repoSuggestions, updateRepo } from "../api";
import { pickTermFolder } from "../term/term-api";
import { appConfirm, SECTION_LABEL } from "../ui/ui";

// A project's repos: named, matched to folders by git remote, each with this machine's checkout
export function ProjectRepos({ board, project, onChanged }: { board: BoardData; project: string; onChanged: () => void }) {
  const repos = board.projects.find((p) => p.id === project)?.repos ?? [];
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) =>
    work().then(() => (setError(null), onChanged()), (e: Error) => setError(e.message));
  const pick = async (start?: string | null) => {
    const r = await pickTermFolder(start);
    return typeof r === "string" ? r : null;
  };
  const add = () => run(async () => {
    const path = await pick();
    if (path) await addRepo(project, path);
  });
  const locate = (r: ProjectRepo) => run(async () => {
    const path = await pick();
    if (path) await updateRepo(r.id, { path });
  });
  const remove = (r: ProjectRepo) => run(async () => {
    if (await appConfirm(`Remove ${r.name} from this project? Its cards stay where they are.`, "Remove")) {
      await removeRepo(r.id);
    }
  });
  // refetched as the project's cards or repos change
  const [suggested, setSuggested] = useState<{ path: string; remote: string; name: string }[]>([]);
  const cardFolders = board.sessions.filter((x) => x.client_id === project && x.repo_path).length;
  useEffect(() => void repoSuggestions(project).then(setSuggested), [project, repos.length, cardFolders]);
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={SECTION_LABEL}>REPOS</span>
        <button type="button" onClick={add} className="text-[12px] text-ink-muted hover:text-copper" title="add a git folder">
          + Add
        </button>
      </div>
      {repos.length === 0 && suggested.length === 0 && (
        <span className="text-[12px] text-ink-faint">
          No repos yet. Add the folders this project works in, and their cards and terminals group under them.
        </span>
      )}
      <div className="flex flex-wrap gap-1.5">
        {repos.map((r) => (
          <span
            key={r.id}
            className="group inline-flex items-center gap-1.5 rounded-md border border-chipline bg-panel px-2 py-0.5 text-[12px]"
            title={`${r.remote}${r.path ? `\n${r.path}` : "\nnot checked out on this machine"}`}
          >
            {renaming === r.id
              ? (
                <input
                  autoFocus
                  defaultValue={r.name}
                  aria-label="repo name"
                  className="w-28 bg-transparent outline-none"
                  onBlur={(e) => {
                    const name = e.currentTarget.value.trim();
                    setRenaming(null);
                    if (name && name !== r.name) void run(() => updateRepo(r.id, { name }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              )
              : (
                <button type="button" className="text-ink" onDoubleClick={() => setRenaming(r.id)} title="double-click to rename">
                  {r.name}
                </button>
              )}
            {!r.path && (
              <button type="button" onClick={() => locate(r)} className="text-[11px] text-copper hover:underline">
                locate
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove ${r.name}`}
              onClick={() => remove(r)}
              className="text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        {suggested.map((x) => (
          <button
            key={x.path}
            type="button"
            title={`add ${x.remote}\n${x.path}`}
            onClick={() => run(() => addRepo(project, x.path))}
            className="inline-flex items-center rounded-md border border-dashed border-chipline px-2 py-0.5 text-[12px] text-ink-muted hover:border-copper/60 hover:text-ink"
          >
            + {x.name}
          </button>
        ))}
      </div>
      {error && <span className="text-[12px] text-[#e06c75]">{error}</span>}
    </section>
  );
}
