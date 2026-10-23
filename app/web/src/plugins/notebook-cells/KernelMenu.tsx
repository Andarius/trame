// The kernel picker: running kernels to switch to or shut down, new ones from a kernel spec or a project folder.
import { useEffect, useState } from "react";
import { MENU_LABEL, MenuRow, Popover, timeAgo } from "../../ui/ui";
import { type Kernel, type KernelSpec, listKernelSpecs, shutdownKernel, startKernel } from "./api";
import { KernelConfig } from "./KernelConfig";

// Jupyter keeps a kernel "starting" until a client connects: past a few seconds it is just unused
const shownState = (k?: Kernel) =>
  k?.state === "starting" && k.lastActivity && Date.now() - Date.parse(k.lastActivity) > 15_000 ? "ready" : k?.state;
// ready = never used: a hollow ring, so it reads apart from a warm idle kernel
const stateDot = (state?: string) =>
  state === "busy"
    ? "bg-copper"
    : state === "idle"
    ? "bg-active"
    : state === "ready"
    ? "border-[1.5px] border-active"
    : state
    ? "bg-paused"
    : "bg-ink-faint";
// the last two folders: enough to tell projects apart
const shortPath = (p: string) => (p.split("/").filter(Boolean).length > 2 ? `…/${p.split("/").filter(Boolean).slice(-2).join("/")}` : p);
const Caret = () => (
  <svg width="9" height="9" viewBox="0 0 10 10" className="text-ink-faint" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function KernelMenu({ kernels, current, onPick, onChanged }: {
  kernels: Kernel[];
  current: string | null;
  onPick: (id: string) => void;
  onChanged: () => void; // a kernel was started or shut down
}) {
  const [open, setOpen] = useState(false);
  const [specs, setSpecs] = useState<KernelSpec[] | null>(null);
  const [configuring, setConfiguring] = useState<KernelSpec | "new" | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const display = (name: string) => specs?.find((s) => s.name === name)?.display ?? name;
  const now = kernels.find((k) => k.id === current);

  const loadSpecs = () => listKernelSpecs().then((r) => setSpecs(r.specs)).catch((e: Error) => setError(e.message));
  useEffect(() => void loadSpecs(), []);
  const show = () => {
    setOpen(true);
    setError(null);
    void loadSpecs();
  };
  const act = (label: string, p: Promise<{ id?: string; ok?: boolean }>) => {
    setPending(label);
    setError(null);
    p.then((r) => {
      if (r.id) {
        onPick(r.id);
        setOpen(false);
      }
      onChanged();
      void loadSpecs();
    }).catch((e: Error) => setError(e.message)).finally(() => setPending(null));
  };

  return (
    <div className="relative">
      <button
        type="button"
        title="kernel"
        onClick={show}
        className="flex items-center gap-2 rounded-md px-2 py-[3px] text-[12px] text-ink hover:bg-panel"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${stateDot(shownState(now))}`} />
        <span className="font-medium">{now ? display(now.name) : "no kernel"}</span>
        {now && <span className="text-ink-faint">{shownState(now)}</span>}
        <Caret />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-[360px] p-1.5">
          <div className={`px-2 pb-1 pt-1 ${MENU_LABEL}`}>RUNNING</div>
          {kernels.length === 0 && <div className="px-2 py-1.5 text-xs text-ink-muted">No kernel running</div>}
          {kernels.map((k) => (
            <MenuRow key={k.id} className="group items-start py-1.5" onClick={() => (onPick(k.id), setOpen(false))}>
              <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${stateDot(shownState(k))}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-ink">{display(k.name)}</span>
                  <span className="font-mono text-[10.5px] text-ink-faint">{k.id.slice(0, 8)}</span>
                </span>
                <span className="block truncate text-[11px] text-ink-muted">
                  {[shownState(k), k.lastActivity && `active ${timeAgo(k.lastActivity)}`, k.path].filter(Boolean).join(" · ")}
                </span>
              </span>
              {k.id === current && <span className="mt-[2px] text-[11px] text-copper">✓</span>}
              <span
                role="button"
                tabIndex={-1}
                title="shut down this kernel"
                className="mt-[1px] hidden rounded px-1 text-[11px] text-ink-muted hover:bg-card hover:text-blocked group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  act(`stop ${k.id}`, shutdownKernel(k.id));
                }}
              >
                shut down
              </span>
            </MenuRow>
          ))}
          <div className="my-1.5 h-px bg-line" />
          <div className={`px-2 pb-1 ${MENU_LABEL}`}>NEW KERNEL</div>
          {!specs && !error && <div className="px-2 py-1.5 text-xs text-ink-muted">Loading…</div>}
          {specs?.map((s) => (
            <MenuRow key={s.name} disabled={!!pending} onClick={() => act(s.name, startKernel(s.name))}>
              <span className="w-2 text-center text-ink-faint">+</span>
              <span className="min-w-0 flex-1 truncate">
                {s.display}
                {s.project && <span className="ml-2 text-[11px] text-ink-faint" title={s.project}>{shortPath(s.project)}</span>}
              </span>
              {pending === s.name && <span className="text-[11px] text-ink-faint">starting…</span>}
              {s.project && (
                <span
                  role="button"
                  tabIndex={-1}
                  title="configure"
                  className="rounded px-1 text-[12px] text-ink-muted hover:bg-card hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    setConfiguring(s);
                  }}
                >
                  ⚙
                </span>
              )}
            </MenuRow>
          ))}
          <MenuRow onClick={() => (setOpen(false), setConfiguring("new"))}>
            <span className="w-2 text-center text-ink-faint">+</span>
            <span className="flex-1">From a project folder…</span>
            <span className="text-[11px] text-ink-faint">pyproject.toml · uv</span>
          </MenuRow>
          {error && <div className="mx-2 mt-1 rounded-md bg-blocked/10 px-2 py-1 text-[11px] text-blocked">{error}</div>}
        </Popover>
      )}
      {configuring && (
        <KernelConfig
          spec={configuring === "new" ? null : configuring}
          onClose={() => setConfiguring(null)}
          onSaved={(id) => {
            setConfiguring(null);
            if (id) onPick(id);
            onChanged();
            void loadSpecs();
          }}
        />
      )}
    </div>
  );
}
