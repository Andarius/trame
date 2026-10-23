// Notebook cells settings: the Jupyter server the page's cells run on. The token is write-only.
import { useEffect, useState } from "react";
import { FIELD_LABEL } from "../../ui/ui";
import { ACTIONS } from "../../editor/pycharm-keymap";
import { getSettings, listKernels, readPyCharmKeymap, saveSettings, setCellKeymap, type Settings } from "./api";

const field = "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-chipline";
const smallBtn = "rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50";

export function NotebookCellsSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((v) => (setS(v), setUrl(v.serverUrl))).catch(() => {});
  }, []);

  const save = () =>
    saveSettings({ serverUrl: url, ...(token ? { token } : {}) }).then((v) => {
      setS(v);
      setToken("");
      setStatus("saved");
    }).catch((e: Error) => setStatus(e.message));
  const importKeymap = () =>
    readPyCharmKeymap().then((km) => {
      const actions = Object.fromEntries(Object.entries(km.actions).filter(([id]) => id in ACTIONS));
      return saveSettings({ keymap: { name: `${km.keymap} (${km.ide ?? "PyCharm"})`, actions } }).then((v) => {
        setS(v);
        setCellKeymap(v.keymap);
        const lost = km.missing.length ? ` · parent not found: ${km.missing.join(", ")}` : "";
        setKeyStatus(`imported ${Object.keys(actions).length} editor actions from ${km.chain.join(" → ")}${lost}`);
      });
    }).catch((e: Error) => setKeyStatus(`✗ ${e.message}`));
  const resetKeymap = () =>
    saveSettings({ keymap: null }).then((v) => (setS(v), setCellKeymap(null), setKeyStatus("back to the default shortcuts")));
  const test = () =>
    listKernels().then((k) => setStatus(`connected · ${k.length} kernel${k.length === 1 ? "" : "s"} running`)).catch((e: Error) =>
      setStatus(`✗ ${e.message}`)
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11.5px] text-ink-muted">
        Cells run on a Jupyter Server you start yourself, e.g. <code className="font-mono">jupyter lab --no-browser</code>. Paste its URL and token
        (<code className="font-mono">jupyter server list</code>).
      </p>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>SERVER URL</span>
        <input className={field} value={url} placeholder="http://127.0.0.1:8888" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>TOKEN {s?.hasToken ? "(stored — leave blank to keep)" : ""}</span>
        <input className={field} type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={smallBtn} onClick={save} disabled={!url.trim()}>Save</button>
        <button type="button" className={smallBtn} onClick={test} disabled={!s?.enabled}>Test connection</button>
        {status && <span className="text-[11.5px] text-ink-muted">{status}</span>}
      </div>
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <span className={FIELD_LABEL}>EDITOR SHORTCUTS</span>
        <span className="text-[11.5px] text-ink-muted">
          {s?.keymap ? `PyCharm keymap: ${s.keymap.name}` : "CodeMirror defaults"}. Running a cell stays on ⇧⏎ and Ctrl+⏎.
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className={smallBtn} onClick={importKeymap} disabled={!s?.enabled}>
            {s?.keymap ? "Re-import from PyCharm" : "Import from PyCharm"}
          </button>
          {s?.keymap && <button type="button" className={smallBtn} onClick={resetKeymap}>Reset</button>}
        </div>
        {keyStatus && <span className="text-[11.5px] text-ink-muted">{keyStatus}</span>}
      </div>
    </div>
  );
}
