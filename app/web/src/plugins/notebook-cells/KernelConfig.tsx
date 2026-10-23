// Project kernel wizard: the folder's pyproject run by uv, then --python, --with packages and env vars.
import { useEffect, useState } from "react";
import { appConfirm, FIELD_LABEL, Modal } from "../../ui/ui";
import {
  type KernelSpec,
  listPythons,
  type ProjectInfo,
  pypiVersions,
  type PyPiProject,
  type PythonVersion,
  readProject,
  removeProjectKernel,
  saveProjectKernel,
} from "./api";

const STEPS = ["Folder", "Python & packages", "Environment", "Review"];

const field =
  "w-full rounded-md border border-chipline bg-transparent px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-muted/50 focus:border-copper/60";
const pill = (on: boolean) =>
  `rounded-md border px-2.5 py-0.5 text-[11.5px] ${on ? "border-copper bg-copper/10 text-copper" : "border-chipline text-ink-soft hover:border-ink-faint"}`;
const chip = "inline-flex items-center gap-1 rounded-full border border-chipline bg-card py-px pl-2.5 pr-1 font-mono text-[11px] text-ink-soft";

const parseEnv = (text: string) =>
  Object.fromEntries(
    text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      const at = l.indexOf("=");
      return at < 0 ? [l, ""] : [l.slice(0, at).trim(), l.slice(at + 1)];
    }),
  );

const quote = (a: string) => (/^[\w./=<>~:@,-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);
// "plotly>=5" → "plotly"
const reqName = (r: string) => r.split(/[\s<>=!~[;@]/)[0];
const versionKey = (v: string) => v.split(".").map(Number);
// lower bound of a plain ">=3.11" requires-python; anything fancier is not judged
const tooOld = (version: string, requires: string | null) => {
  const min = /^\s*>=\s*(\d+)\.(\d+)/.exec(requires ?? "");
  if (!min) return false;
  const [ma, mi] = versionKey(version);
  return ma < Number(min[1]) || (ma === Number(min[1]) && mi < Number(min[2]));
};

function useDebounced<T>(value: T, ms: number) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

const Label = ({ text, hint }: { text: string; hint?: string }) => (
  <span className="mb-1 flex items-baseline justify-between">
    <span className={FIELD_LABEL}>{text}</span>
    {hint && <span className="text-[10.5px] text-ink-faint">{hint}</span>}
  </span>
);

// --with input: type a name, pick latest or a release from PyPI, or type a uv requirement
function PackagePicker({ onAdd }: { onAdd: (req: string) => void }) {
  const [text, setText] = useState("");
  const name = useDebounced(reqName(text.trim()), 350);
  const [found, setFound] = useState<PyPiProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    setError(null);
    if (!name) return;
    let live = true;
    pypiVersions(name).then((p) => live && setFound(p)).catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [name]);
  const add = (req: string) => {
    onAdd(req);
    setText("");
  };
  const typedSpec = text.trim() !== reqName(text.trim());
  return (
    <div>
      <input
        className={`${field} font-mono text-[12px]`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && text.trim()) {
            e.preventDefault();
            add(text.trim());
          }
        }}
        placeholder="polars, plotly>=5, numpy==2.1.3"
      />
      {text.trim() && (found || error) && (
        <div className="mt-1 max-h-[180px] overflow-y-auto rounded-lg border border-line bg-panel p-1">
          {error && <div className="px-2 py-1.5 text-[11.5px] text-blocked">{error}</div>}
          {found && (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] text-ink-faint">{found.summary}</div>
              {typedSpec && (
                <button type="button" className="flex w-full justify-between rounded-md px-2 py-1 text-left font-mono text-[11.5px] text-ink-soft hover:bg-hover" onClick={() => add(text.trim())}>
                  {text.trim()}<span className="font-sans text-ink-faint">as typed ⏎</span>
                </button>
              )}
              <button type="button" className="flex w-full justify-between rounded-md px-2 py-1 text-left font-mono text-[11.5px] text-ink hover:bg-hover" onClick={() => add(found.name)}>
                {found.name}<span className="font-sans text-ink-faint">latest · {found.latest}</span>
              </button>
              {found.versions.map((v) => (
                <button key={v.version} type="button" className="flex w-full justify-between rounded-md px-2 py-1 text-left font-mono text-[11.5px] text-ink-soft hover:bg-hover" onClick={() => add(`${found.name}==${v.version}`)}>
                  =={v.version}<span className="font-sans text-ink-faint">{v.at}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Chips({ items, more = 0 }: { items: string[]; more?: number }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((d) => <span key={d} className={`${chip} pr-2.5 opacity-75`}>{d}</span>)}
      {more > 0 && <span className="px-1 text-[11px] text-ink-faint">+{more}</span>}
    </div>
  );
}

export function KernelConfig({ spec, onClose, onSaved }: {
  spec: KernelSpec | null; // null: a new project kernel
  onClose: () => void;
  onSaved: (kernelId: string | null) => void; // started kernel, or null when only saved
}) {
  const c = spec?.config;
  const [step, setStep] = useState(spec ? 3 : 0);
  const [path, setPath] = useState(c?.project ?? "");
  const [display, setDisplay] = useState(c?.display ?? "");
  const [python, setPython] = useState(c?.python ?? "");
  const [packages, setPackages] = useState<string[]>(c?.packages ?? []);
  const [env, setEnv] = useState(Object.entries(c?.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [pythons, setPythons] = useState<PythonVersion[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folderPath = useDebounced(path.trim(), 300);
  useEffect(() => {
    setProject(null);
    setProjectError(null);
    if (!folderPath) return;
    let live = true;
    readProject(folderPath).then((p) => live && setProject(p)).catch((e: Error) => live && setProjectError(e.message));
    return () => void (live = false);
  }, [folderPath]);
  useEffect(() => void listPythons().then(setPythons).catch(() => {}), []);

  const ready = !!project && project.dir.length > 0 && folderPath === path.trim();
  const folder = path.trim().replace(/\/+$/, "").split("/").pop() || "project";
  const envVars = parseEnv(env);
  const command = [
    "uv run --directory",
    quote(path.trim() || "<folder>"),
    ...(python ? ["--python", quote(python)] : []),
    ...["ipykernel", ...packages].flatMap((p) => ["--with", quote(p)]),
    "python -m ipykernel_launcher",
  ].join(" ");
  const pyChoices = python && !pythons.some((p) => p.version === python)
    ? [{ version: python, installed: false }, ...pythons]
    : pythons;

  const save = (start: boolean) => {
    if (!ready || busy) return;
    setBusy(start ? "starting" : "saving");
    setError(null);
    saveProjectKernel({ path: path.trim(), display, python, packages, env: envVars }, start)
      .then((r) => onSaved(r.id ?? null))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };
  const remove = async () => {
    if (!spec || !(await appConfirm(`Remove the kernel "${spec.display}"? Running kernels keep going.`, "Remove"))) return;
    removeProjectKernel(spec.name).then(() => onSaved(null)).catch((e: Error) => setError(e.message));
  };
  const addPackage = (req: string) =>
    setPackages((ps) => [...ps.filter((p) => reqName(p).toLowerCase() !== reqName(req).toLowerCase()), req]);

  const deps = project?.dependencies ?? [];
  const shownDeps = showDeps ? deps : deps.slice(0, 8);

  return (
    <Modal width={560} label="Configure kernel" onClose={onClose} onSubmit={() => save(true)}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">{spec ? `Configure ${spec.display}` : "New project kernel"}</h2>
        <span className="text-[11px] text-ink-faint">pyproject.toml · uv</span>
      </div>
      <ol className="flex items-center gap-1.5 text-[11.5px]">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <button
              type="button"
              disabled={!ready && i > 0}
              onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 whitespace-nowrap disabled:cursor-default ${i === step ? "text-ink" : "text-ink-faint hover:text-ink-soft"}`}
            >
              <span
                className={`grid size-[18px] place-items-center rounded-full border text-[10px] ${
                  i === step ? "border-copper text-copper" : i < step ? "border-active bg-active text-canvas" : "border-chipline"
                }`}
              >
                {i < step ? "✓" : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-line" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col">
            <Label text="PROJECT FOLDER" hint="--directory · absolute path" />
            <input autoFocus className={`${field} font-mono text-[12px]`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/projects/analysis" />
          </label>
          {projectError && path.trim() && <div className="text-[11.5px] text-blocked">{projectError}</div>}
          {project && (
            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2.5 text-[12px]">
              <span className="text-ink-faint">project</span>
              <span className="text-ink">{project.name ?? folder} {project.version && <span className="text-ink-muted">{project.version}</span>}</span>
              <span className="text-ink-faint">requires-python</span>
              <span className="font-mono text-ink-soft">{project.requiresPython ?? "any"}</span>
              <span className="text-ink-faint">dependencies</span>
              <span className="text-ink-soft">{deps.length ? `${deps.slice(0, 3).map(reqName).join(", ")}${deps.length > 3 ? ` +${deps.length - 3}` : ""}` : "none"}</span>
              <span className="text-ink-faint">lockfile</span>
              <span className={project.lock ? "text-active" : "text-paused"}>{project.lock ? "✓ uv.lock" : "none, uv resolves on first start"}</span>
            </div>
          )}
          <label className="flex flex-col">
            <Label text="NAME" hint="in the kernel menu" />
            <input className={field} value={display} onChange={(e) => setDisplay(e.target.value)} placeholder={`${project?.name ?? folder} (uv)`} />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3.5">
          <div>
            <Label text="--PYTHON" hint={project?.requiresPython ? `project requires ${project.requiresPython}` : undefined} />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={pill(!python)} onClick={() => setPython("")}>project's</button>
              {pyChoices.map((p) => {
                const old = tooOld(p.version, project?.requiresPython ?? null);
                return (
                  <button
                    key={p.version}
                    type="button"
                    title={old ? `below ${project?.requiresPython}` : p.installed ? "installed" : "uv downloads it on first start"}
                    className={`${pill(python === p.version)} inline-flex items-center gap-1.5 ${old ? "opacity-40" : ""}`}
                    onClick={() => setPython(p.version)}
                  >
                    {p.version}
                    {p.installed && <span className="size-1.5 rounded-full bg-active" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <Label text="DEPENDENCIES" hint="from pyproject.toml, uv installs them" />
            {deps.length ? <Chips items={shownDeps} more={showDeps ? 0 : deps.length - shownDeps.length} /> : <span className="text-[11.5px] text-ink-faint">none</span>}
            {deps.length > 8 && (
              <button type="button" className="mt-1 text-[11px] text-ink-faint hover:text-ink-soft" onClick={() => setShowDeps(!showDeps)}>
                {showDeps ? "show less" : "show all"}
              </button>
            )}
            {!!project?.dev.length && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[10.5px] text-ink-faint">dev</span>
                <Chips items={project.dev.slice(0, 6)} more={project.dev.length - 6} />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label text="--WITH" hint="kernel only, pyproject.toml is not changed" />
            {packages.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {packages.map((p) => (
                  <span key={p} className={chip}>
                    {p}
                    <button type="button" aria-label={`remove ${p}`} className="px-1 text-ink-faint hover:text-blocked" onClick={() => setPackages(packages.filter((x) => x !== p))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <PackagePicker onAdd={addPackage} />
          </div>
        </div>
      )}

      {step === 2 && (
        <label className="flex flex-col">
          <Label text="ENVIRONMENT" hint="KEY=value per line, like a .env file" />
          <textarea autoFocus rows={6} className={`${field} resize-y font-mono text-[12px]`} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={"PGHOST=localhost\nNB_DARK=1"} />
          <span className="mt-1 text-[10.5px] text-ink-faint">Stored in plain text in the kernel spec: keep secrets out.</span>
        </label>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-lg border border-line text-[12px]">
            {[
              ["Folder", <span key="v" className="font-mono">{path.trim() || "—"}</span>, 0],
              ["Name", display || `${project?.name ?? folder} (uv)`, 0],
              ["--python", python || "project's", 1],
              ["--with", packages.length ? <span key="v" className="font-mono">{packages.join(" ")}</span> : "nothing extra", 1],
              ["Environment", Object.keys(envVars).length ? <span key="v" className="font-mono">{Object.keys(envVars).join(", ")}</span> : "none", 2],
            ].map(([k, v, i]) => (
              <div key={k as string} className="grid grid-cols-[100px_1fr_auto] items-baseline gap-3 border-t border-line px-3 py-2 first:border-t-0">
                <span className="text-[11.5px] text-ink-faint">{k}</span>
                <span className="break-all text-ink-soft">{v}</span>
                <button type="button" className="text-[11px] text-ink-faint hover:text-copper" onClick={() => setStep(i as number)}>edit</button>
              </div>
            ))}
          </div>
          <div className="flex flex-col">
            <Label text="RUNS" hint="in the project folder" />
            <code className="block break-all rounded-md bg-card px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">{command}</code>
            {spec && <span className="mt-1 text-[10.5px] text-ink-faint">Running kernels keep their old settings until restarted.</span>}
          </div>
          {!ready && <div className="text-[11.5px] text-paused">{projectError ?? "Checking the project folder…"}</div>}
        </div>
      )}

      {error && <div className="rounded-md bg-blocked/10 px-2.5 py-1.5 text-[11.5px] text-blocked">{error}</div>}
      <div className="mt-1 flex items-center gap-2">
        {step > 0 && <button type="button" className="rounded-md px-2.5 py-1 text-[12px] text-ink-soft hover:bg-hover" onClick={() => setStep(step - 1)}>Back</button>}
        {spec && step === 3 && <button type="button" className="rounded-md px-2.5 py-1 text-[12px] text-ink-muted hover:bg-blocked/10 hover:text-blocked" onClick={() => void remove()}>Remove</button>}
        <span className="flex-1" />
        {step < 3 && (
          <>
            <button type="button" disabled={!ready} className="rounded-md px-3 py-1 text-[12px] text-ink-soft hover:bg-hover disabled:opacity-40" onClick={() => setStep(3)}>Skip to review</button>
            <button type="button" disabled={!ready} className="rounded-md bg-copper px-3 py-1 text-[12px] font-semibold text-copper-ink hover:brightness-110 disabled:opacity-40" onClick={() => setStep(step + 1)}>Next</button>
          </>
        )}
        {step === 3 && (
          <>
            {spec && <button type="button" disabled={!ready || !!busy} className="rounded-md border border-chipline px-3 py-1 text-[12px] text-ink-soft hover:border-copper hover:text-copper disabled:opacity-40" onClick={() => save(false)}>{busy === "saving" ? "Saving…" : "Save"}</button>}
            <button type="button" disabled={!ready || !!busy} className="rounded-md bg-copper px-3 py-1 text-[12px] font-semibold text-copper-ink hover:brightness-110 disabled:opacity-40" onClick={() => save(true)}>
              {busy === "starting" ? "Starting…" : spec ? "Save & start" : "Create & start"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
