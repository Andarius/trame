// Notebook plugin panel: one notebook from a Jupyter server, framed same-origin through the
// backend proxy in a chrome-less Lab workspace; a thin bar picks the notebook, starts/attaches/
// stops the server, exports and follows Trame's theme.
import { useCallback, useEffect, useRef, useState } from "react";
import { openInBrowser } from "../../api";
import { EmptyState, STRING_CODEC, useLocalStorage } from "../../ui/ui";
import {
  attachServer,
  effectiveTheme,
  exportHtml,
  getStatus,
  listNotebooks,
  type NotebookStatus,
  notebookPath,
  openNotebook,
  parseLabUrl,
  setTheme,
  startServer,
  stopServer,
} from "./api";

const btn = "rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50";
const primary = "rounded-md bg-copper px-2.5 py-0.5 text-[11px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-50";
const field = "rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-ink outline-none focus:border-chipline";
const PLACEHOLDER = "http://127.0.0.1:8888/lab/tree/analysis.ipynb?token=…";

function useTrameTheme(): "light" | "dark" {
  const [theme, set] = useState(effectiveTheme);
  useEffect(() => {
    const update = () => set(effectiveTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

export function NotebookPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [status, setStatus] = useState<NotebookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<string[]>([]);
  const [path, setPath] = useLocalStorage("trame:notebook:path", "", STRING_CODEC);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  // the iframe reloads when the Lab theme setting changed under it
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [themed, setThemed] = useState<"light" | "dark" | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useTrameTheme();

  const refresh = useCallback(() => getStatus().then((s) => {
    setStatus(s);
    setError(s.error);
  }).catch((e: Error) => setError(e.message)), []);

  useEffect(() => void refresh(), [refresh]);
  // poll while a server is coming up
  useEffect(() => {
    if (!status?.starting) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [status?.starting, refresh]);

  // Lab reads its theme from the server's settings: write Trame's before the frame loads, reload on change
  const upstream = status?.server?.upstream ?? null;
  useEffect(() => {
    if (!upstream) {
      setThemed(null);
      return;
    }
    let live = true;
    setTheme(theme).then((r) => {
      if (!live) return;
      if (themed !== null && r.changed) setFrameEpoch((n) => n + 1);
      setThemed(theme);
    }).catch(() => live && setThemed(theme));
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `themed` is the previous value, not a trigger
  }, [upstream, theme]);

  // the server's notebooks, for the picker
  useEffect(() => {
    if (!upstream) {
      setNotebooks([]);
      return;
    }
    let live = true;
    listNotebooks().then((list) => live && setNotebooks(list)).catch(() => live && setNotebooks([]));
    return () => {
      live = false;
    };
  }, [upstream]);

  // the picked notebook becomes the one document of Trame's Lab workspace
  useEffect(() => {
    if (!upstream || !path) {
      setFrameUrl(null);
      return;
    }
    let live = true;
    openNotebook(path).then((r) => live && setFrameUrl(r.url)).catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [upstream, path]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attachPasted = () => {
    const parsed = parseLabUrl(pasted);
    if (!parsed) {
      setError("Paste a Jupyter URL, e.g. the one in your browser's address bar.");
      return;
    }
    void run(async () => {
      await attachServer(parsed.url, parsed.token ?? undefined);
      if (parsed.path) setPath(parsed.path);
      setPasted("");
    });
  };

  const openPath = (): string | null => {
    try {
      return notebookPath(frame.current?.contentWindow?.location.pathname ?? "") ?? (path || null);
    } catch {
      return path || null;
    }
  };

  const doExport = (to: "report" | "file") => {
    const target = openPath();
    if (!target) {
      setError("Pick a notebook first.");
      return;
    }
    void run(async () => {
      const r = await exportHtml(target, to);
      if (to === "report" && r.url) {
        setNotice(`Report created from ${target}.`);
        await openInBrowser(new URL(r.url, globalThis.location.origin).toString());
      } else if (r.file) setNotice(`Saved ${r.file}`);
    });
  };

  if (!status) return <EmptyState page>{error ?? "Loading…"}</EmptyState>;

  const server = status.server;
  const fullLab = server
    ? new URL(path ? `${server.url}/tree/${path.split("/").map(encodeURIComponent).join("/")}` : server.url, globalThis.location.origin)
      .toString()
    : null;
  const options = path && !notebooks.includes(path) ? [path, ...notebooks] : notebooks;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        {server
          ? (
            <>
              <select
                className={`${field} max-w-96`}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                title={server.rootDir ?? server.upstream}
              >
                <option value="">Pick a notebook…</option>
                {options.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <span className="text-[11px] text-ink-muted/70" title={server.upstream}>
                {server.mode === "spawned" ? "started by Trame" : `attached · ${server.upstream}`}
              </span>
              <span className="flex-1" />
              <button type="button" className={btn} disabled={busy || !path} onClick={() => doExport("report")}>
                Export → Trame report
              </button>
              <button type="button" className={btn} disabled={busy || !path} onClick={() => doExport("file")}>
                Export → .html
              </button>
              <button type="button" className={btn} onClick={() => setFrameEpoch((n) => n + 1)}>Reload</button>
              <button type="button" className={btn} onClick={() => fullLab && void openInBrowser(fullLab)}>
                Open in browser
              </button>
              <button type="button" className={btn} disabled={busy} onClick={() => void run(stopServer)}>
                {server.mode === "spawned" ? "Stop" : "Detach"}
              </button>
            </>
          )
          : (
            <>
              <input
                className={`${field} w-72`}
                value={cwd ?? status.rootDir}
                onChange={(e) => setCwd(e.target.value)}
                title="folder the server starts in"
                spellCheck={false}
              />
              <button
                type="button"
                className={primary}
                disabled={busy || status.starting}
                onClick={() => void run(() => startServer(cwd ?? status.rootDir))}
              >
                {status.starting ? "Starting…" : "Start JupyterLab"}
              </button>
              <span className="flex-1" />
              <button type="button" className={btn} onClick={onOpenSettings}>Settings</button>
            </>
          )}
      </div>
      {(error || notice) && (
        <div className={`px-3 py-1 text-[11.5px] ${error ? "text-blocked" : "text-ink-muted"}`}>{error ?? notice}</div>
      )}
      {server
        ? (frameUrl && themed
          ? (
            <iframe
              key={`${frameUrl}#${frameEpoch}`}
              ref={frame}
              src={frameUrl}
              title="JupyterLab"
              className="block min-h-0 w-full flex-1 border-0 bg-panel"
              allow="clipboard-read; clipboard-write"
            />
          )
          : (
            <EmptyState page>
              {path ? "Opening…" : notebooks.length ? "Pick a notebook above." : "No notebook found under the server's folder."}
            </EmptyState>
          ))
        : (
          <div className="flex flex-col gap-3 overflow-auto p-4">
            {status.running.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">RUNNING SERVERS</span>
                {status.running.map((s) => (
                  <div key={s.url} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                    <span className="font-mono text-[11.5px] text-ink">{s.url}</span>
                    <span className="truncate text-[11px] text-ink-muted/70">{s.rootDir ?? ""}</span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      className={primary}
                      disabled={busy}
                      onClick={() => void run(() => attachServer(s.url))}
                    >
                      Attach
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                className={`${field} w-[28rem]`}
                placeholder={PLACEHOLDER}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && attachPasted()}
                spellCheck={false}
              />
              <button type="button" className={btn} disabled={busy || !pasted.trim()} onClick={attachPasted}>
                Attach by URL
              </button>
            </div>
            {status.log.length > 0 && (status.starting || error) && (
              <pre className="m-0 max-h-64 overflow-auto rounded-lg border border-line bg-panel p-2 font-mono text-[10.5px] text-ink-muted">
                {status.log.join("\n")}
              </pre>
            )}
          </div>
        )}
    </div>
  );
}
