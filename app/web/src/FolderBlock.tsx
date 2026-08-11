import { useEffect, useState } from "react";
import { type Block, type FolderEntry, getReportFileContent, listFolder, openPath } from "./api";

type FolderB = Extract<Block, { type: "folder" }>;

const EXT_ICON: Record<string, string> = {
  html: "🌐", htm: "🌐", xlsx: "📊", xls: "📊", csv: "📊",
  py: "🐍", js: "🐍", ts: "🐍", sh: "🐍",
  md: "📄", txt: "📄", pdf: "📕", json: "🔧",
};
const iconFor = (e: FolderEntry) => e.kind === "dir" ? "📁" : (EXT_ICON[e.ext] ?? "📄");
// Display ~ instead of /home/<user> so the path stays short and portable-looking.
const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

export function FolderBlock(
  { block, onPatch, onRemove, onOpenReport }: {
    block: FolderB;
    onPatch: (patch: Partial<FolderB>) => void;
    onRemove: () => void;
    onOpenReport: (path: string) => void;
  },
) {
  const view = block.view ?? "list";
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(!block.path);
  const [draft, setDraft] = useState(block.path);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!block.path) {
      setEntries(null);
      setErr(null);
      return;
    }
    let live = true;
    listFolder(block.path).then((r) => {
      if (!live) return;
      if ("error" in r) {
        setErr(r.error === "not allowed or not found" ? "hors des dossiers autorisés (config Explore) ou introuvable" : r.error);
        setEntries(null);
      } else {
        setErr(null);
        setEntries(r.entries);
      }
    });
    return () => {
      live = false;
    };
  }, [block.path]);

  // Lazily fetch HTML for gallery thumbnails once the gallery view is shown.
  useEffect(() => {
    if (view !== "gallery" || !entries) return;
    for (const e of entries) {
      if (!e.isHtml || e.path in thumbs) continue;
      getReportFileContent(e.path)
        .then((r) => setThumbs((t) => ({ ...t, [e.path]: r.html ?? "" })))
        .catch(() => setThumbs((t) => ({ ...t, [e.path]: "" })));
    }
  }, [view, entries]);

  const commitPath = () => {
    const v = draft.trim();
    setEditing(false);
    if (v !== block.path) onPatch({ path: v });
  };

  const Toggle = () => (
    <div className="flex overflow-hidden rounded-md border border-chipline text-[10.5px]">
      {(["list", "gallery"] as const).map((v) => (
        <button
          type="button"
          key={v}
          onClick={() => onPatch({ view: v })}
          className={`px-2 py-[3px] font-medium transition-colors ${
            view === v ? "bg-copper text-copper-ink" : "text-ink-muted hover:bg-panel"
          }`}
        >
          {v === "list" ? "Liste" : "Galerie"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-line bg-block">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="text-sm">📁</span>
        {editing
          ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitPath}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPath();
                if (e.key === "Escape") {
                  setDraft(block.path);
                  setEditing(false);
                }
              }}
              placeholder="~/chemin/vers/le/dossier"
              className="min-w-0 flex-1 border-none bg-transparent font-mono text-[11.5px] text-ink-soft outline-none placeholder:text-ink-muted/40"
            />
          )
          : (
            <button
              type="button"
              onClick={() => {
                setDraft(block.path);
                setEditing(true);
              }}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink-soft hover:text-ink"
              title={block.path}
            >
              {short(block.path)}
            </button>
          )}
        {entries && (
          <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-muted">
            <span className="rounded-full border border-chip-active-border bg-chip-active-bg px-2 py-[1px] text-[10px] font-semibold text-active">
              live
            </span>
            {entries.length} fichier{entries.length > 1 ? "s" : ""}
          </span>
        )}
        {entries && <Toggle />}
        <button
          type="button"
          onClick={onRemove}
          title="retirer le bloc"
          className="shrink-0 rounded px-1 text-ink-muted/60 hover:bg-panel hover:text-blocked"
        >
          ×
        </button>
      </div>

      {/* body */}
      {err && <div className="px-3 py-3 text-[11.5px] text-ink-muted">⚠ {err}</div>}
      {!block.path && !err && (
        <div className="px-3 py-3 text-[11.5px] text-ink-muted">Renseigne un dossier ci-dessus.</div>
      )}
      {entries && entries.length === 0 && (
        <div className="px-3 py-3 text-[11.5px] text-ink-muted">Dossier vide.</div>
      )}

      {entries && entries.length > 0 && view === "list" && (
        <div>
          {entries.map((e) => (
            <div
              key={e.path}
              className="flex items-center gap-2.5 border-t border-line-soft px-3 py-[7px] text-[12.5px] first:border-t-0 hover:bg-hover"
            >
              <span className="shrink-0 text-[13px]">{iconFor(e)}</span>
              <span className="min-w-0 flex-1 truncate text-ink-soft">{e.name}</span>
              {e.isHtml && (
                <button
                  type="button"
                  onClick={() => onOpenReport(e.path)}
                  className="shrink-0 rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-copper hover:border-copper"
                >
                  Explore
                </button>
              )}
              <button
                type="button"
                onClick={() => openPath(e.path)}
                className="shrink-0 rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper"
              >
                ouvrir
              </button>
            </div>
          ))}
        </div>
      )}

      {entries && entries.length > 0 && view === "gallery" && (
        <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3">
          {entries.map((e) => (
            <button
              type="button"
              key={e.path}
              onClick={() => openPath(e.path)}
              className="group overflow-hidden rounded-lg border border-line bg-card text-left transition-colors hover:border-copper"
              title={`ouvrir ${e.name}`}
            >
              <div className="relative h-[86px] overflow-hidden bg-[#f3f2ee]">
                {e.isHtml && thumbs[e.path]
                  ? (
                    <iframe
                      sandbox=""
                      srcDoc={thumbs[e.path]}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
                      style={{ width: "250%", height: "250%", transform: "scale(0.4)" }}
                    />
                  )
                  : (
                    <div className="flex h-full items-center justify-center bg-block text-2xl">
                      {iconFor(e)}
                    </div>
                  )}
              </div>
              <div className="truncate border-t border-line-soft px-2 py-1.5 text-[11px] text-ink-soft">
                {e.name}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
