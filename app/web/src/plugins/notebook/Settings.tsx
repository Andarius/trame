// Notebook settings: the command that starts JupyterLab and the folder it starts in.
import { useEffect, useState } from "react";
import { getPluginSettings, savePluginSettings } from "../../api";
import { FIELD_LABEL } from "../../ui/ui";
import type { NotebookSettings } from "./api";

const field =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-chipline";

export function NotebookSettingsView() {
  const [settings, setSettings] = useState<NotebookSettings | null>(null);
  const [command, setCommand] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getPluginSettings("notebook").then((s) => {
      const v = s as NotebookSettings;
      setSettings(v);
      setCommand(v.command);
      setRootDir(v.rootDir);
    }).catch(() => {});
  }, []);

  if (!settings) return null;
  const dirty = command !== settings.command || rootDir !== settings.rootDir;
  const save = () =>
    savePluginSettings("notebook", { command, rootDir }).then((s) => {
      setSettings(s as NotebookSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>START COMMAND</span>
        <input className={field} value={command} placeholder={settings.defaultCommand} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        <span className="text-[11px] text-ink-muted/70">
          Trame appends its own flags (port, token, base URL). Example for a project env:{" "}
          <code>uv run --with jupyterlab jupyter lab</code>
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>DEFAULT FOLDER</span>
        <input className={field} value={rootDir} placeholder="~" onChange={(e) => setRootDir(e.target.value)} spellCheck={false} />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty}
          onClick={() => void save()}
          className="rounded-md bg-copper px-3 py-1 text-[12px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-50"
        >
          Save
        </button>
        {saved && <span className="text-[11px] text-ink-muted">Saved.</span>}
      </div>
    </div>
  );
}
