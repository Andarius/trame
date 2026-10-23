// Under a page's brief: export the page's cells as a standalone HTML report, import an .ipynb's cells.
import { useEffect, useRef, useState } from "react";
import { type Block, type CellOutput, openInBrowser, type PageDetail, updatePage } from "../../api";
import { clearAll, runAll } from "../../editor/cell-mode";
import { createReport, getSettings, interrupt, type Kernel, listKernels, readNotebook, restart, setPreferredKernel, usePreferredKernel } from "./api";
import { pageToHtml } from "./export-html";
import { KernelMenu } from "./KernelMenu";

const btn = "rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper disabled:opacity-40";
const ghost = "rounded-md px-2 py-[3px] text-[11.5px] text-ink-soft hover:bg-panel hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

// The page's one kernel: every cell runs on it (Jupyter's top-right kernel indicator).
function KernelBar({ cells }: { cells: number }) {
  const kernel = usePreferredKernel();
  const [kernels, setKernels] = useState<Kernel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const cancel = useRef(false);
  const load = () =>
    listKernels().then((list) => {
      setKernels(list);
      setError(null);
      if (!list.some((k) => k.id === kernel)) setPreferredKernel(list[0]?.id ?? null);
    }).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- polls the kernel list and its busy state
  }, [kernel]);
  const current = kernels?.find((k) => k.id === kernel);
  const busy = runningAll || current?.state === "busy";
  const fail = (e: Error) => setError(e.message);
  const runEverything = () => {
    cancel.current = false;
    setRunningAll(true);
    runAll(() => cancel.current).finally(() => setRunningAll(false));
  };
  const stopEverything = () => {
    cancel.current = true;
    if (kernel) interrupt(kernel).catch(fail);
  };
  return (
    <>
      {kernels
        ? <KernelMenu kernels={kernels} current={kernel} onPick={setPreferredKernel} onChanged={() => void load()} />
        : <span className="px-2">{error ?? "connecting…"}</span>}
      <span className="mx-1 h-4 w-px bg-chipline" />
      {busy
        ? <button type="button" className={ghost} onClick={stopEverything} disabled={!kernel}>■ Stop</button>
        : <button type="button" className={ghost} onClick={runEverything} disabled={!kernel || cells === 0}>▶ Run all</button>}
      <button
        type="button"
        className={ghost}
        title="restart the kernel: its variables are lost, outputs stay"
        disabled={!kernel}
        onClick={() => kernel && (cancel.current = true, restart(kernel).then(load).catch(fail))}
      >
        ↻ Restart
      </button>
      <button type="button" className={ghost} onClick={() => void clearAll()} disabled={cells === 0 || runningAll}>⌫ Clear outputs</button>
      {error && kernels && <span className="text-blocked">{error}</span>}
    </>
  );
}

export function NotebookCellsPageHeader({ page, onDone }: { page: PageDetail; onDone: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [importing, setImporting] = useState(false);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    getSettings().then((s) => setEnabled(s.enabled)).catch(() => {});
  }, []);
  const cells = page.content.filter((b) => b.type === "code").length;
  if (!enabled && cells === 0) return null;

  const exportHtml = () =>
    createReport(page.title, pageToHtml(page.title, page.content))
      .then((r) => openInBrowser(`/report/${r.id}`))
      .then(() => setStatus("exported to Reports"))
      .catch((e: Error) => setStatus(e.message));

  const importCells = () =>
    readNotebook(path.trim()).then((nb) => {
      const blocks: Block[] = nb.cells.map((c) =>
        c.cell_type === "code"
          ? { type: "code", source: c.source, outputs: (c.outputs ?? []) as CellOutput[], count: c.count ?? null, id: crypto.randomUUID() }
          : { type: "text", text: c.source, id: crypto.randomUUID() }
      );
      return updatePage(page.id, { content: [...page.content, ...blocks] });
    }).then(() => {
      setImporting(false);
      setStatus(null);
      onDone();
    }).catch((e: Error) => setStatus(e.message));

  return (
    // sticky: the kernel and run controls stay in reach down a long notebook
    <div className="sticky top-0 z-30 -mx-2 bg-canvas px-2 py-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-card px-2.5 py-1.5 text-[11.5px] text-ink-muted">
        {enabled && <KernelBar cells={cells} />}
        <span className="flex-1" />
        <span className="mr-1">{cells} cell{cells === 1 ? "" : "s"}</span>
        <button type="button" className={btn} onClick={exportHtml} disabled={cells === 0}>Export HTML</button>
        {importing
          ? (
            <>
              <input
                autoFocus
                className="w-64 rounded-md border border-line bg-panel px-2 py-[2px] text-[11.5px] text-ink outline-none focus:border-chipline"
                placeholder="notebook path on the server, e.g. deviations.ipynb"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && path.trim()) importCells();
                  if (e.key === "Escape") setImporting(false);
                }}
              />
              <button type="button" className={btn} onClick={importCells} disabled={!path.trim()}>Import</button>
            </>
          )
          : <button type="button" className={btn} onClick={() => setImporting(true)}>Import .ipynb</button>}
        {status && <span>{status}</span>}
      </div>
    </div>
  );
}
