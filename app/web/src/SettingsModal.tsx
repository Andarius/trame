import { useEffect, useRef, useState } from "react";
import {
  type AgentPresenceSettings,
  applyUpdate,
  completePath,
  getPlugins,
  getSettings,
  getUpdate,
  openInBrowser,
  patchSettings,
  type PluginManifest,
  syncNow,
  testHub,
  type UpdateInfo,
} from "./api";
import { PresencePreview } from "./PresencePreview";
import { applyScale, getScale, SCALES } from "./scale";
import { applyTheme, getTheme, type Theme } from "./theme";
import { CheckRow, Footer, label, pill, seg, segTrack } from "./modal-ui";
import { Modal, IconButton } from "./ui";
import { dataUriToIcon } from "./udb/cells";

// One folder input with directory autocomplete: typing fetches sub-dir suggestions
// (debounced), ↑/↓ to move, Enter/Tab to accept, Esc to dismiss, click to pick.
function PathRow(
  { value, placeholder, autoFocus, onChange, onRemove }: {
    value: string;
    placeholder: string;
    autoFocus: boolean;
    onChange: (v: string) => void;
    onRemove: () => void;
  },
) {
  const [sugg, setSugg] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(blurTimer.current);
  }, []);

  const fetchSugg = (v: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      completePath(v).then((dirs) => {
        const d = dirs.filter((x) => x !== v); // hide a lone suggestion equal to the input
        setSugg(d);
        setHi(0);
        setOpen(d.length > 0);
      });
    }, 120);
  };
  const accept = (d: string) => {
    onChange(d);
    setOpen(false);
    fetchSugg(`${d}/`); // offer the chosen folder's children next
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative w-full">
        <input
          className={`${pill} w-full`}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            fetchSugg(e.target.value);
          }}
          onFocus={() => value && fetchSugg(value)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={(e) => {
            if (!open || sugg.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => (h + 1) % sugg.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => (h - 1 + sugg.length) % sugg.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              if (sugg[hi]) {
                e.preventDefault();
                accept(sugg[hi]);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {open && sugg.length > 0 && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-chipline bg-panel shadow-lg">
            {sugg.map((d, k) => (
              <button type="button"
                key={d}
                className={`block w-full truncate px-2 py-1 text-left font-mono text-[11px] ${
                  k === hi ? "bg-sidebar text-ink" : "text-ink-soft"
                }`}
                // mousedown (not click) fires before the input's blur closes the list
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(d);
                }}
                onMouseEnter={() => setHi(k)}
              >
                {d}
              </button>
            ))}
          </div>
        )}
      </div>
      <IconButton tone="danger" className="px-1"
        title="remove"
        onClick={onRemove}
      >
        ✕
      </IconButton>
    </div>
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
        <PathRow
          key={i}
          value={p}
          placeholder={placeholder}
          autoFocus={i === items.length - 1 && p === ""}
          onChange={(v) => onChange(items.map((x, j) => j === i ? v : x))}
          onRemove={() => onChange(items.filter((_, j) => j !== i))}
        />
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
  { onClose, onSaved, onOpenPlugins }: {
    onClose: () => void;
    onSaved: () => void;
    onOpenPlugins: () => void;
  },
) {
  const [paths, setPaths] = useState<string[]>([]);
  const [ignore, setIgnore] = useState<string[]>([]);
  const [source, setSource] = useState<"settings" | "env">("settings");
  const [hubUrl, setHubUrl] = useState("");
  const [hubToken, setHubToken] = useState("");
  const [hubHasToken, setHubHasToken] = useState(false);
  const [hubSource, setHubSource] = useState<"settings" | "env" | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updState, setUpdState] = useState<"idle" | "busy" | "done">("idle");
  const [scale, setScale] = useState(getScale);
  const [theme, setTheme] = useState(getTheme);
  const [authorName, setAuthorName] = useState("");
  const [authorAvatar, setAuthorAvatar] = useState("");
  const [pluginList, setPluginList] = useState<PluginManifest[]>([]);
  const [presence, setPresence] = useState<AgentPresenceSettings | null>(null);
  const setP = (patch: Partial<AgentPresenceSettings>) => setPresence((p) => p && { ...p, ...patch });

  useEffect(() => {
    getSettings().then((s) => {
      setPresence(s.agentPresence);
      setPaths(s.paths.length ? s.paths : [""]);
      setIgnore(s.ignore ?? []);
      setAuthorName(s.authorName ?? "");
      setAuthorAvatar(s.authorAvatar ?? "");
      setSource(s.source);
      // only prefill when saved here — an env-provided URL stays in the env
      // unless the user types one (mirrors the report-paths takeover behavior);
      // never clobber what the user already typed while this request was in flight
      setHubUrl((cur) => cur || (s.hubSource === "settings" ? s.hubApi : ""));
      setHubHasToken(s.hubSource === "settings" && s.hubHasToken);
      setHubSource(s.hubSource);
      setLoaded(true);
    }).catch(() => setLoaded(true));
    getUpdate().then((u) => {
      setUpdate(u);
      if (u.applied) setUpdState("done");
    }).catch(() => {});
    getPlugins().then(setPluginList).catch(() => {});
  }, []);

  const runUpdate = () => {
    if (!update) return;
    if (!update.canSelfUpdate) {
      openInBrowser(update.releaseUrl);
      return;
    }
    if (updState !== "idle") return;
    setUpdState("busy");
    applyUpdate().then((r) => setUpdState(r.ok ? "done" : "idle")).catch(() => setUpdState("idle"));
  };

  const [hubTest, setHubTest] = useState<{ state: "idle" | "busy" | "ok" | "fail"; tls?: boolean; error?: string }>(
    { state: "idle" },
  );
  const runHubTest = () => {
    if (hubTest.state === "busy") return;
    setHubTest({ state: "busy" });
    testHub(hubUrl.trim(), hubToken.trim())
      .then((r) => setHubTest(r.ok ? { state: "ok", tls: r.tls } : { state: "fail", error: r.error }))
      .catch((e) => setHubTest({ state: "fail", error: String(e) }));
  };

  const submit = () =>
    patchSettings({
      reportPaths: paths.map((p) => p.trim()).filter(Boolean),
      ignorePaths: ignore.map((p) => p.trim()).filter(Boolean),
      hubApi: hubUrl.trim(),
      hubApiToken: hubToken.trim(), // blank = keep the stored one
      authorName: authorName.trim(),
      authorAvatar: authorAvatar.trim(),
      agentPresence: presence ?? undefined,
    }).then(() => {
      if (hubUrl.trim()) syncNow().catch(() => {}); // first sync right away
      onSaved();
      onClose();
    });

  return (
    <Modal full label="Settings" onClose={onClose} onSubmit={submit}>
      <div className="flex items-center">
        <div className={label}>SETTINGS</div>
        <span className="flex-1" />
        <IconButton title="Close (Esc)"
          aria-label="Close settings"
          autoFocus
          className="rounded-md px-2 py-1 text-[18px] leading-none text-ink-muted hover:bg-panel hover:text-ink-soft"
          onClick={onClose}
        >
          ✕
        </IconButton>
      </div>

      <div className="text-[14px] font-semibold">Updates</div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-soft">Trame v{update?.current ?? "…"}</span>
        {update?.available
          ? (
            <>
              <span className="rounded bg-copper/15 px-1.5 py-0.5 text-[10.5px] font-medium text-copper">
                v{update.latest} available
              </span>
              <button
                type="button"
                className="text-[10.5px] text-ink-muted underline decoration-chipline underline-offset-2 hover:text-ink-soft"
                onClick={() => update && openInBrowser(update.releaseUrl)}
              >
                release notes
              </button>
              <span className="flex-1" />
              {updState === "done"
                ? <span className="text-[11px]" style={{ color: "var(--color-active)" }}>✓ updated — restart Trame</span>
                : (
                  <button
                    type="button"
                    className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-60"
                    disabled={updState === "busy"}
                    onClick={runUpdate}
                  >
                    {updState === "busy" ? "Updating…" : update.canSelfUpdate ? "Update now" : "Open release"}
                  </button>
                )}
            </>
          )
          : update?.applied
          ? <span className="text-[11px]" style={{ color: "var(--color-active)" }}>✓ updated — restart Trame</span>
          : update && <span className="text-[11px] text-ink-muted/70">· up to date</span>}
      </div>

      <div className="h-px bg-line" />
      <div className="text-[14px] font-semibold">Interface scale</div>
      <div className="flex items-center gap-2">
        <div className={segTrack}>
          {SCALES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === scale} className={seg(s === scale)}
              onClick={() => {
                setScale(s);
                applyScale(s);
              }}
            >
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
        <span className="text-[12px] text-ink-muted/70">applies instantly</span>
      </div>

      <div className="h-px bg-line" />
      <div className="text-[14px] font-semibold">Theme</div>
      <div className={segTrack}>
        {(["system", "light", "dark"] as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={t === theme} className={`${seg(t === theme)} capitalize`}
            onClick={() => {
              setTheme(t);
              applyTheme(t);
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {presence
        ? <AgentPresenceSection p={presence} set={setP} />
        : loaded && (
          <>
            <div className="h-px bg-line" />
            <div className="text-[14px] font-semibold">Agent presence</div>
            <p className="m-0 text-[12.5px] text-blocked">Couldn't load these settings — reopen Settings to retry.</p>
          </>
        )}

      <div className="h-px bg-line" />
      <div className="text-[14px] font-semibold">Your name</div>
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
        Shown as the author on comments you write (so teammates see who said what). Empty falls back to this machine's node id.
      </p>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          title={authorAvatar ? "change avatar" : "choose an avatar image"}
          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-panel text-ink-muted transition-colors hover:border-chipline"
          onClick={async () => {
            const res = await fetch("/api/pick-image", { method: "POST" }).then((r) => r.json()).catch(() => null);
            if (res?.dataUri) setAuthorAvatar(await dataUriToIcon(res.dataUri));
          }}
        >
          {authorAvatar
            ? <img src={authorAvatar} alt="" className="h-full w-full object-cover" />
            : <span className="text-[15px]">＋</span>}
        </button>
        <input
          className={`${pill} w-64`}
          placeholder="e.g. Julien"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          maxLength={40}
        />
        {authorAvatar && (
          <button
            type="button"
            className="text-[11px] text-ink-muted transition-colors hover:text-blocked"
            onClick={() => setAuthorAvatar("")}
          >
            Remove avatar
          </button>
        )}
      </div>

      <div className="h-px bg-line" />
      <div className="text-[14px] font-semibold">Sync hub</div>
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
        Hub API URL and its device token (minted on the hub).{" "}
        {hubSource === "env"
          ? "Currently from TRACKER_HUB_API — saving here takes over."
          : hubSource === null
          ? "Not configured — local-only until set."
          : "Saved in settings.json."}
      </p>
      <div className="flex gap-1.5">
        <input
          className={`${pill} min-w-0 flex-1 font-mono text-[11px]`}
          placeholder="https://192.168.1.x:8443"
          value={hubUrl}
          onChange={(e) => {
            setHubUrl(e.target.value);
            setHubTest({ state: "idle" });
          }}
          spellCheck={false}
        />
        <input
          type="password"
          className={`${pill} w-44 font-mono text-[11px]`}
          placeholder={hubHasToken ? "•••••• (saved)" : "device token"}
          title={hubHasToken ? "a token is saved — type to replace it" : "the device token minted on the hub"}
          value={hubToken}
          onChange={(e) => {
            setHubToken(e.target.value);
            setHubTest({ state: "idle" });
          }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
          disabled={hubTest.state === "busy" || (!hubUrl.trim() && hubSource === null)}
          onClick={runHubTest}
        >
          {hubTest.state === "busy" ? "Testing…" : "Test connection"}
        </button>
        {hubTest.state === "ok" && (
          <span className="text-[11px]" style={{ color: "var(--color-active)" }}>
            ✓ connected{hubTest.tls ? " · TLS" : " · no TLS!"}
          </span>
        )}
        {hubTest.state === "fail" && (
          <span className="min-w-0 truncate text-[11px] text-blocked" title={hubTest.error}>
            ✕ {hubTest.error}
          </span>
        )}
      </div>

      <div className="h-px bg-line" />
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold">Plugins</span>
        <span className="text-[10.5px] text-ink-muted/70">
          {pluginList.filter((p) => p.enabled).length} of {pluginList.length} enabled
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="rounded-md border border-chipline px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
          onClick={onOpenPlugins}
        >
          Manage plugins →
        </button>
      </div>

      <div className="h-px bg-line" />
      <button
        type="button"
        className="flex items-center gap-2 text-left text-[14px] font-semibold text-ink hover:text-copper"
        onClick={() => setExploreOpen((v) => !v)}
      >
        <span className="w-3 text-[12px] text-ink-muted">{exploreOpen ? "▾" : "▸"}</span>
        Explore — report folders
        <span className="text-[10.5px] font-normal text-ink-muted/70">
          {paths.filter(Boolean).length} folder{paths.filter(Boolean).length === 1 ? "" : "s"} · {ignore.filter(Boolean).length} ignored
        </span>
      </button>
      {exploreOpen && (
        <>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
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
          <div className="pt-1 text-[14px] font-semibold">Ignore</div>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
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
        </>
      )}
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

// mirrors normalizeAgentPresence in app/files.ts
const clampMinutes = (p: AgentPresenceSettings) => {
  const clamp = (v: number, def: number, lo: number, hi: number) =>
    Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
  const liveMinutes = clamp(p.liveMinutes, 2, 1, 30);
  return { liveMinutes, staleMinutes: clamp(p.staleMinutes, 30, Math.max(5, liveMinutes), 240) };
};

function AgentPresenceSection(
  { p, set }: { p: AgentPresenceSettings; set: (patch: Partial<AgentPresenceSettings>) => void },
) {
  const fields: [keyof AgentPresenceSettings["fields"], string][] = [
    ["harness", "Harness"],
    ["provider", "Provider"],
    ["model", "Model"],
    ["tokens", "Tokens so far"],
    ["step", "Last step"],
  ];
  const row: [keyof Pick<AgentPresenceSettings, "chip" | "tint" | "timer" | "motion">, string][] = [
    ["chip", "Pulsing chip + verb"],
    ["tint", "Tint row"],
    ["timer", "Elapsed timer"],
    ["motion", "Animations"],
  ];
  return (
    <>
      <div className="h-px bg-line" />
      <div className="text-[14px] font-semibold">Agent presence</div>
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
        How a todo shows that an agent is working on it. The preview below follows your choices.
      </p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className={label}>STATUS MARKER</span>
          <div className={segTrack}>
            <button type="button" aria-pressed={p.marker === "ring"} className={seg(p.marker === "ring")} onClick={() => set({ marker: "ring" })}>
              Spinning checkbox
            </button>
            <button type="button" aria-pressed={p.marker === "rail"} className={seg(p.marker === "rail")} onClick={() => set({ marker: "rail" })}>
              Gutter rail
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={label}>ACTIVITY LINE</span>
          <div className={segTrack}>
            {([["always", "Always"], ["hover", "On hover"], ["off", "Off"]] as const).map(([a, l]) => (
              <button key={a} type="button" aria-pressed={p.activity === a} className={seg(p.activity === a)} onClick={() => set({ activity: a })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={label}>ACTIVITY LINE FIELDS</span>
          {fields.map(([k, l]) => (
            <CheckRow key={k} on={p.fields[k]} label={l} onChange={(v) => set({ fields: { ...p.fields, [k]: v } })} />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={label}>ROW</span>
          {row.map(([k, l]) => <CheckRow key={k} on={p[k]} label={l} onChange={(v) => set({ [k]: v })} />)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-soft">
        <label className="flex items-center gap-2">
          Agent counts as live if seen within
          <input
            type="number"
            min={1}
            max={30}
            className={`${pill} w-14`}
            value={p.liveMinutes}
            onChange={(e) => set({ liveMinutes: Number(e.target.value) })}
            onBlur={() => set(clampMinutes(p))}
          />
          min
        </label>
        <label className="flex items-center gap-2">
          Mark as stale after
          <input
            type="number"
            min={5}
            max={240}
            className={`${pill} w-16`}
            value={p.staleMinutes}
            onChange={(e) => set({ staleMinutes: Number(e.target.value) })}
            onBlur={() => set(clampMinutes(p))}
          />
          min of silence
        </label>
      </div>
      <PresencePreview p={p} />
    </>
  );
}
