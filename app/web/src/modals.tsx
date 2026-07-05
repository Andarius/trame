import { type ReactNode, useEffect, useState } from "react";
import { type BoardData, getSettings, patchSettings, type Status } from "./api";
import { Select, STATUS, StatusDot } from "./ui";

function Modal(
  { width = 560, onClose, onSubmit, children }: {
    width?: number;
    onClose: () => void;
    onSubmit: () => void;
    children: ReactNode;
  },
) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose, onSubmit]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[16vh]" onClick={onClose}>
      <div
        className="flex max-h-[76vh] flex-col gap-3 overflow-y-auto rounded-xl border border-[#323649] bg-[#171923] p-5 shadow-2xl shadow-black/50"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const label = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/80";
const input =
  "w-full bg-transparent outline-none placeholder:text-ink-muted/50 border-none p-0 text-ink";
const STORY_PLACEHOLDER = "The story — why this matters.\n\nDone when:\n·  …\n·  …";
const pill =
  "appearance-none rounded-md border border-chipline bg-transparent px-2 py-1 text-[11.5px] text-ink-soft outline-none";

function Footer(
  { hint, action, onClose, onSubmit, disabled }: {
    hint: string;
    action: string;
    onClose: () => void;
    onSubmit: () => void;
    disabled: boolean;
  },
) {
  return (
    <>
      <div className="h-px bg-line" />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[10.5px] text-ink-muted/85">{hint}</span>
        <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
          Cancel
        </button>
        <button type="button"
          className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink disabled:opacity-40"
          onClick={onSubmit}
          disabled={disabled}
        >
          {action} <span className="text-[10.5px] opacity-70">⌘↵</span>
        </button>
      </div>
    </>
  );
}

export function NewSessionModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (s: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [client, setClient] = useState(board.clients[0]?.name ?? "");
  const [objective, setObjective] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [branch, setBranch] = useState("");
  const [nextStep, setNextStep] = useState("");

  const obj = objective === "__new__" ? newObjective : objective;
  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      status,
      client: client || undefined,
      objective: obj || undefined,
      branch: branch || undefined,
      next_step: nextStep || undefined,
    });
  };

  return (
    <Modal onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW SESSION</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="repo — short topic"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded-md border border-chipline py-1 pl-2 pr-1">
          <StatusDot status={status} size={7} />
          <Select
            value={status}
            className="bg-transparent px-1 text-[11.5px] text-ink-soft outline-none"
            options={Object.entries(STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
            onChange={(v) => setStatus(v as Status)}
          />
        </span>
        <Select
          value={client}
          className={pill}
          options={board.clients.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
        <Select
          value={objective}
          className={pill}
          options={[
            { value: "", label: "◎ no project" },
            ...board.objectives.map((o) => ({ value: o.title, label: `◎ ${o.title}` })),
            { value: "__new__", label: "＋ new project…" },
          ]}
          onChange={setObjective}
        />
        <input
          className={`${pill} w-36`}
          placeholder="⎇ branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      {objective === "__new__" && (
        <input
          className={`${pill} w-full`}
          placeholder="new project title (created on save)"
          value={newObjective}
          onChange={(e) => setNewObjective(e.target.value)}
        />
      )}
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-ink-soft">→</span>
        <input
          className={`${input} text-[12.5px]`}
          placeholder="next step (imperative, one line)"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
        />
      </div>
      <Footer
        hint="/project:track fills all of this automatically from a repo"
        action="Create session"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}

function PathList(
  { items, onChange, placeholder, addLabel }: {
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
    addLabel: string;
  },
) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            className={`${pill} w-full`}
            value={p}
            autoFocus={i === items.length - 1 && p === ""}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => j === i ? e.target.value : x))}
          />
          <button type="button"
            className="px-1 text-ink-muted hover:text-blocked"
            title="remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button"
        className="w-fit rounded-md px-1 py-0.5 text-[11.5px] text-ink-muted hover:text-ink-soft"
        onClick={() => onChange([...items, ""])}
      >
        {addLabel}
      </button>
    </div>
  );
}

export function SettingsModal(
  { onClose, onSaved }: { onClose: () => void; onSaved: () => void },
) {
  const [paths, setPaths] = useState<string[]>([]);
  const [ignore, setIgnore] = useState<string[]>([]);
  const [source, setSource] = useState<"settings" | "env">("settings");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setPaths(s.paths.length ? s.paths : [""]);
      setIgnore(s.ignore ?? []);
      setSource(s.source);
      setAutoUpdate(s.autoUpdate === true);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const submit = () =>
    patchSettings({
      reportPaths: paths.map((p) => p.trim()).filter(Boolean),
      ignorePaths: ignore.map((p) => p.trim()).filter(Boolean),
      autoUpdate,
    }).then(() => {
      onSaved();
      onClose();
    });

  return (
    <Modal width={620} onClose={onClose} onSubmit={submit}>
      <div className={label}>SETTINGS</div>
      <div className="text-base font-semibold">Explore — report folders</div>
      <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
        Folders scanned (4 levels deep) for <code>.html</code> exploration reports. Searchable in
        the Explore view alongside published reports.
        {source === "env" && " Currently coming from TRACKER_REPORT_PATHS — saving here takes over."}
      </p>
      {loaded && (
        <PathList
          items={paths}
          onChange={setPaths}
          placeholder="~/Projects or /absolute/path"
          addLabel="＋ Add folder"
        />
      )}
      <div className="pt-1 text-[12.5px] font-semibold">Ignore</div>
      <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
        A folder <em>name</em> (<code>htmlcov</code> ≡ <code>**/htmlcov</code>) ignores it anywhere;
        a <em>path</em> (<code>~/Projects/x/devops</code>) ignores that subtree; <em>globs</em> work
        too (<code>~/Projects/**/coverage</code>, <code>**/*.min.html</code>).{" "}
        <code>node_modules</code>, <code>.git</code>, <code>dist</code>… are always ignored.
      </p>
      {loaded && (
        <PathList
          items={ignore}
          onChange={setIgnore}
          placeholder="externals — or ~/path/to/skip"
          addLabel="＋ Add ignore"
        />
      )}
      <div className="pt-1 text-[12.5px] font-semibold">Updates</div>
      <button
        type="button"
        className="flex w-fit items-center gap-2 text-xs text-ink-soft"
        onClick={() => setAutoUpdate((v) => !v)}
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] transition-colors ${
            autoUpdate ? "border-copper bg-copper text-copper-ink" : "border-chipline text-transparent"
          }`}
        >
          ✓
        </span>
        Update silently in the background (AppImage) — otherwise Trame notifies and proposes the update
      </button>
      <Footer
        hint="stored per-machine in settings.json (not synced)"
        action="Save settings"
        onClose={onClose}
        onSubmit={submit}
        disabled={!loaded}
      />
    </Modal>
  );
}

export function NewUdbModal(
  { onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void },
) {
  const [name, setName] = useState("");
  const submit = () => name.trim() && onCreate(name.trim());
  return (
    <Modal width={440} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW DATABASE</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="e.g. Benchmarks, Metrics log…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <Footer
        hint="columns are added from the table's “+” header cell"
        action="Create database"
        onClose={onClose}
        onSubmit={submit}
        disabled={!name.trim()}
      />
    </Modal>
  );
}

export function NewObjectiveModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (o: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [client, setClient] = useState(board.clients[0]?.name ?? "");
  const [story, setStory] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({ title: title.trim(), client: client || undefined, story });
  };

  return (
    <Modal width={720} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW PROJECT</div>
      <input
        autoFocus
        className={`${input} text-xl font-semibold`}
        placeholder="What are we trying to achieve?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="w-56">
        <Select
          value={client}
          className={pill}
          options={board.clients.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-[#101219] p-3">
        <textarea
          className={`${input} min-h-[190px] resize-none text-[13px] leading-relaxed`}
          placeholder={STORY_PLACEHOLDER}
          value={story}
          onChange={(e) => setStory(e.target.value)}
        />
        <span className="text-[10.5px] text-ink-muted/80">
          The story — what are we trying to achieve? Sessions ladder up here.
        </span>
      </div>
      <Footer
        hint="projects are also created automatically by /project:track"
        action="Create project"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}
