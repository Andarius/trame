import { type ReactNode, useMemo, useRef, useState } from "react";
import { pickTermFolder } from "../term/term-api";
import { appConfirm, Button, EmptyState, ErrorNote, Field, SegToggle, TextArea, TextInput, timeAgo } from "../ui/ui";
import { MODES, modeOf, type Provider, useAgentRuns } from "./agent-run";
import { AgentIcon } from "./agents";
import {
  type Bot,
  BOT_IMAGE_MAX,
  BOT_IMAGE_TYPES,
  BOT_NAME,
  botHook,
  type BotHook,
  botName,
  type BotRun,
  botRuns,
  botStats,
  type BotStats,
  createBot,
  deleteBot,
  deleteBotImage,
  type Face,
  hookCommand,
  putBotImage,
  rotateBotHook,
  runBot,
  type RunSource,
  updateBot,
  useBots,
  usePoll,
} from "./bot-api";
import { BotAvatar, bumpBotImage, FACE_IDS, Glyph, hueWash, type BotState, Switch, TRIGGER_TONE } from "./bot-faces";
import { fmtSeconds, folderName, nameHue, pct, type RunLabel, runLabel, runSeconds } from "./bot-stats";
import { BotWiring } from "./BotWiring";

type Tab = "overview" | "wiring" | "settings";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "wiring", label: "Wiring" },
  { value: "settings", label: "Settings" },
];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
export const SOURCE: Record<RunSource, { glyph: "slack" | "hook" | "relay" | "hand"; label: string }> = {
  slack: { glyph: "slack", label: "Slack" },
  hook: { glyph: "hook", label: "Hook" },
  app: { glyph: "hand", label: "Trame" },
  relay: { glyph: "relay", label: "Relay" },
};
const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-full border border-chipline px-2 py-[2px] text-[11px] text-ink-soft";
export const CARD = "rounded-xl border border-line bg-panel";
const CARD_HEAD = "flex items-center justify-between gap-2 border-b border-line px-3.5 py-[11px]";
const fail = (set: (e: string) => void) => (e: unknown) => set(e instanceof Error ? e.message : String(e));

// what a bot is doing now, from its live count and recent runs
export const botState = (bot: Pick<Bot, "working">, runs: BotRun[] | null): BotState =>
  runs?.some((r) => r.needsYou) ? "needs you" : bot.working > 0 || runs?.some((r) => runLabel(r) === "working") ? "working" : "idle";

// A bot in the main pane: its identity, activity and triggers (Overview), how it is wired, its settings.
// `botId` null is a new bot's draft, shown as Settings with Create.
export function BotPage(
  { botId, onOpenRun, onCreated, onDeleted }: {
    botId: string | null;
    onOpenRun: (run: string) => void;
    onCreated: (bot: string) => void;
    onDeleted: () => void;
  },
) {
  const { bots, loaded, reload } = useBots(true);
  const bot = botId ? bots.find((b) => b.id === botId) ?? null : null;
  if (!botId) {
    return (
      <div className="@container min-h-full bg-canvas">
        <div className="border-b border-line px-7 pb-[18px] pt-[26px]" style={hueWash(28)}>
          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-ink">New bot</h2>
          <p className="mt-0.5 text-ink-soft">An agent that Slack, a hook or you start fresh runs of, in one folder.</p>
        </div>
        <Settings bot={null} onSaved={(b) => (reload(), onCreated(b.id))} onDeleted={onDeleted} reload={reload} />
      </div>
    );
  }
  if (!loaded) return null;
  if (!bot) return <EmptyState page>This bot no longer exists.</EmptyState>;
  return <BotView key={bot.id} bot={bot} reload={reload} onOpenRun={onOpenRun} onDeleted={onDeleted} />;
}

function BotView(
  { bot, reload, onOpenRun, onDeleted }: { bot: Bot; reload: () => void; onOpenRun: (run: string) => void; onDeleted: () => void },
) {
  const [tab, setTab] = useState<Tab>("overview");
  const runs = usePoll(() => botRuns(bot.id, 50), 5000, bot.id);
  const stats = usePoll(() => botStats(bot.id, 30), 30_000, bot.id);
  const [composing, setComposing] = useState(false);
  const state = botState(bot, runs.data);
  const mode = bot.provider === "claude" ? modeOf(bot.mode)?.label : null;
  return (
    <div className="@container min-h-full bg-canvas">
      <div className="border-b border-line px-7 pb-[18px] pt-[26px]" style={hueWash(bot.hue)}>
        <div className="flex items-center gap-[18px]">
          <BotAvatar bot={bot} size="xl" state={state} provider ring="border-canvas" />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">{bot.name}</h2>
            <p className="mb-2 mt-0.5 text-[13px] text-ink-soft">
              {bot.role || (
                <button type="button" className="text-ink-faint hover:text-copper" onClick={() => setTab("settings")}>
                  Give it a role…
                </button>
              )}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <span className={CHIP}>
                <AgentIcon a={{ harness: bot.provider, icon: null }} size="h-3 w-3" />
                {PROVIDER_LABEL[bot.provider]}
              </span>
              {mode && (
                <span className={CHIP}>
                  <Glyph name={modeOf(bot.mode)!.mode} />
                  {mode}
                </span>
              )}
              <span className={`${CHIP} font-mono`} title={bot.cwd}>
                <Glyph name="folder" className="h-3.5 w-3.5" />
                <span className="truncate">{bot.cwd}</span>
              </span>
              {state !== "idle" && (
                <span className={CHIP}>
                  <Dot label={state === "working" ? "working" : "needs you"} />
                  {state === "working" ? `${Math.max(bot.working, 1)} running` : "needs you"}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 self-start">
            <Button variant="primary" className="inline-flex items-center gap-1.5" onClick={() => setComposing(!composing)}>
              <Glyph name="play" />
              Run now
            </Button>
          </div>
        </div>
        {composing && (
          <RunComposer
            bot={bot}
            onCancel={() => setComposing(false)}
            onRun={(run) => (setComposing(false), runs.reload(), reload(), onOpenRun(run))}
          />
        )}
      </div>
      <div className="flex gap-4 border-b border-line px-7" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            className={`-mb-px border-b-2 py-2.5 text-[13px] font-medium ${
              tab === t.value ? "border-copper text-ink" : "border-transparent text-ink-muted hover:text-ink-soft"
            }`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
            {t.value === "overview" && stats.data ? <span className="ml-1.5 text-ink-faint">{stats.data.runs}</span> : null}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <Overview bot={bot} runs={runs.data} runsError={runs.error} stats={stats.data} reload={reload} onOpenRun={onOpenRun} />
      )}
      {tab === "wiring" && <BotWiring bot={bot} state={state} runs={runs.data} stats={stats.data} />}
      {tab === "settings" && <Settings bot={bot} onSaved={reload} onDeleted={onDeleted} reload={reload} />}
    </div>
  );
}

function RunComposer({ bot, onRun, onCancel }: { bot: Bot; onRun: (run: string) => void; onCancel: () => void }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    runBot(bot.id, task.trim()).then((r) => onRun(r.id), (e) => (setBusy(false), fail(setError)(e)));
  };
  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <TextArea
        autoFocus
        rows={3}
        value={task}
        placeholder={`What should ${bot.name} do?`}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink-faint">a fresh run in {folderName(bot.cwd)} · ⌘/Ctrl+Enter</span>
        <Button variant="ghost" className="ml-auto" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!task.trim() || busy} onClick={run}>Run</Button>
      </div>
    </div>
  );
}

const LABEL_DOT: Record<RunLabel, string> = {
  working: "bg-live",
  "needs you": "bg-wait",
  finished: "bg-ink-faint",
  failed: "bg-blocked",
  stopped: "border border-ink-faint",
};
function Dot({ label }: { label: RunLabel }) {
  return <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${LABEL_DOT[label]}`} />;
}
export function RunStatus({ label }: { label: RunLabel }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-ink-soft">
      <Dot label={label} />
      {label}
    </span>
  );
}

function Kpi({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel px-3 py-2.5">
      <b className="block text-[18px] font-semibold text-ink">{value}</b>
      <span className="block text-[11px] text-ink-faint">{label}</span>
    </div>
  );
}

function Overview(
  { bot, runs, runsError, stats, reload, onOpenRun }: {
    bot: Bot;
    runs: BotRun[] | null;
    runsError: string | null;
    stats: BotStats | null;
    reload: () => void;
    onOpenRun: (run: string) => void;
  },
) {
  const open = useAgentRuns(true);
  const held = useMemo(() => new Set(open.map((r) => r.id)), [open]);
  const [all, setAll] = useState(false);
  const spark = stats?.daily.slice(-14) ?? [];
  const max = Math.max(1, ...spark.map((d) => d.runs));
  const finished = stats ? pct(stats.success, stats.runs) : null;
  const shown = all ? runs ?? [] : (runs ?? []).slice(0, 8);
  return (
    <div className="grid gap-4 px-7 py-[18px] @3xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-2.5 @xl:grid-cols-4">
          <Kpi value={stats?.runs ?? "—"} label="runs, 30 days" />
          <Kpi value={finished == null ? "—" : `${finished}%`} label="finished" />
          <Kpi value={fmtSeconds(stats?.medianSeconds) ?? "—"} label="median run" />
          <div className="rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <div className="flex h-[26px] items-end gap-[2px]" aria-label="runs per day, last 14 days">
              {spark.map((d) => (
                <i
                  key={d.day}
                  title={`${d.day}: ${d.runs} run${d.runs === 1 ? "" : "s"}${d.failed ? `, ${d.failed} failed` : ""}`}
                  className={`w-[5px] rounded-[2px] ${d.runs ? (d.failed ? "bg-blocked" : "bg-copper/70") : "bg-line"}`}
                  style={{ height: d.runs ? `${Math.max(12, (d.runs / max) * 100)}%` : "2px" }}
                />
              ))}
            </div>
            <span className="block text-[11px] text-ink-faint">14 days</span>
          </div>
        </div>
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <h4 className="m-0 text-[12px] font-semibold text-ink">Recent runs</h4>
            {(runs?.length ?? 0) > 8 && (
              <Button variant="link" onClick={() => setAll(!all)}>{all ? "Fewer" : `All ${runs!.length} →`}</Button>
            )}
          </div>
          {runsError && !runs && <div className="px-3.5 py-3"><ErrorNote>{runsError}</ErrorNote></div>}
          {runs && !runs.length && (
            <p className="px-3.5 py-5 text-center text-[12px] text-ink-faint">
              No runs yet. Start one with Run now{bot.slack ? `, a Slack mention (@Trame ${bot.name}: …)` : ""} or its hook.
            </p>
          )}
          {shown.map((r) => {
            const label = runLabel(r);
            const can = r.live || held.has(r.id);
            const took = fmtSeconds(runSeconds(r));
            return (
              <button
                key={r.id}
                type="button"
                disabled={!can}
                title={can ? "open this run" : "this run was closed; only its record stays"}
                className="flex w-full items-center gap-2.5 border-t border-line-soft px-3.5 py-[9px] text-left first-of-type:border-t-0 enabled:hover:bg-hover"
                onClick={() => onOpenRun(r.id)}
              >
                <span
                  className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-active-row text-ink-soft"
                  title={SOURCE[r.source].label}
                >
                  <Glyph name={SOURCE[r.source].glyph} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-ink">{r.summary || <i className="text-ink-faint">no task</i>}</span>
                  <small className="block truncate text-[11px] text-ink-faint">
                    {r.requester} · {timeAgo(r.startedAt)}
                    {took && ` · ${took}`}
                  </small>
                </span>
                <RunStatus label={label} />
              </button>
            );
          })}
        </div>
      </div>
      <StartedBy bot={bot} runs={runs} reload={reload} />
    </div>
  );
}

function TriggerRow(
  { glyph, title, children, aside, off }: {
    glyph: keyof typeof TRIGGER_TONE;
    title: string;
    children: ReactNode;
    aside?: ReactNode;
    off?: boolean;
  },
) {
  return (
    <div className={`flex items-start gap-3 border-t border-line-soft px-3.5 py-3 first-of-type:border-t-0 ${off ? "opacity-55" : ""}`}>
      <span className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] ${TRIGGER_TONE[glyph]}`}>
        <Glyph name={glyph} className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h5 className="m-0 text-[13px] font-semibold text-ink">{title}</h5>
        <div className="mt-0.5 text-[11.5px] text-ink-faint">{children}</div>
      </div>
      {aside}
    </div>
  );
}

function StartedBy({ bot, runs, reload }: { bot: Bot; runs: BotRun[] | null; reload: () => void }) {
  const [hook, setHook] = useState<BotHook | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastHook = runs?.find((r) => r.source === "hook");
  const toggleSlack = (on: boolean) => updateBot(bot.id, { slack: on }).then(reload, fail(setError));
  const copy = async (fresh: boolean) => {
    if (fresh && !await appConfirm("Make a new secret? The current hook command stops working.", "New secret")) return;
    (fresh ? rotateBotHook(bot.id) : botHook(bot.id))
      .then((h) => (setHook(h), navigator.clipboard.writeText(hookCommand(h))))
      .then(() => setNotice(fresh ? "New secret made; its command is copied." : "Hook command copied."), fail(setError));
  };
  return (
    <div className={`${CARD} self-start`}>
      <div className={CARD_HEAD}>
        <h4 className="m-0 text-[12px] font-semibold text-ink">Started by</h4>
      </div>
      <TriggerRow
        glyph="slack"
        title="Slack"
        off={!bot.slack}
        aside={<Switch on={bot.slack} label={bot.slack ? "stop Slack mentions" : "start on Slack mentions"} onChange={toggleSlack} />}
      >
        <span className="font-mono">@Trame {bot.name}: …</span> in any channel Trame is in
      </TriggerRow>
      <TriggerRow glyph="hook" title="Hook">
        cron, CI or a script · {lastHook ? `last call ${timeAgo(lastHook.startedAt)}` : "never called"}
        {hook && (
          <div className="mt-2 truncate rounded-[7px] border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] text-ink-soft">
            {hookCommand({ ...hook, token: "••••" })}
          </div>
        )}
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" onClick={() => void copy(false)}>Copy hook command</Button>
          <Button size="sm" variant="ghost" title="make a new secret; the old command stops working" onClick={() => void copy(true)}>
            New secret
          </Button>
        </div>
        {notice && <div className="mt-1.5 text-ink-muted">{notice}</div>}
        {error && <ErrorNote className="mt-1.5">{error}</ErrorNote>}
      </TriggerRow>
      <TriggerRow glyph="relay" title="Agent relay" off aside={<Switch on={false} disabled label="coming soon" />}>
        other machines' agents can ask {bot.name} · coming soon
      </TriggerRow>
      <TriggerRow glyph="clock" title="Schedule" off aside={<Switch on={false} disabled label="coming soon" />}>
        e.g. weekdays 08:00 · coming soon
      </TriggerRow>
    </div>
  );
}

const PROVIDERS: { value: Provider; label: ReactNode }[] = (["claude", "codex"] as const).map((p) => ({
  value: p,
  label: (
    <span className="inline-flex items-center gap-1.5">
      <AgentIcon a={{ harness: p, icon: null }} size="h-3 w-3" />
      {PROVIDER_LABEL[p]}
    </span>
  ),
}));
const MODE_OPTIONS = MODES.map((m) => ({
  value: m.mode as string,
  label: (
    <span className="inline-flex items-center gap-1.5">
      <Glyph name={m.mode} />
      {m.label}
    </span>
  ),
}));
const HUE_TRACK = `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 359].map((h) => `hsl(${h} 70% 55%)`).join(", ")})`;
const THUMB =
  "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-canvas [&::-webkit-slider-thumb]:bg-ink [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-canvas [&::-moz-range-thumb]:bg-ink";

function Settings(
  { bot, onSaved, onDeleted, reload }: { bot: Bot | null; onSaved: (b: Bot) => void; onDeleted: () => void; reload: () => void },
) {
  const [name, setName] = useState(bot?.name ?? "");
  const [cwd, setCwd] = useState(bot?.cwd ?? "");
  const [provider, setProvider] = useState<Provider>(bot?.provider ?? "claude");
  const [mode, setMode] = useState<string>(modeOf(bot?.mode ?? "auto")?.mode ?? "auto");
  const [role, setRole] = useState(bot?.role ?? "");
  const [face, setFace] = useState<Face>(bot?.face ?? "f1");
  const [hue, setHue] = useState<number | null>(bot ? bot.hue : null); // null: follows the draft's name
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const shownHue = hue ?? nameHue(name || "bot");
  const valid = BOT_NAME.test(name) && cwd.startsWith("/");
  const onError = fail((e) => (setNotice(null), setError(e)));

  const choose = async () => {
    const picked = await pickTermFolder(cwd || null).catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") {
      const folder = picked.replace(/\/+$/, "");
      setCwd(folder);
      if (!name) setName(botName(folder));
    } else if (picked && "error" in picked) setError(picked.error);
  };
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const body = {
      name,
      cwd,
      provider,
      mode: provider === "claude" ? mode : null,
      role: role.trim(),
      face,
      ...(!bot || hue !== bot.hue ? { hue: shownHue } : {}),
    };
    try {
      const saved = await (bot ? updateBot(bot.id, body) : createBot(body));
      setNotice(bot ? "Saved." : null);
      onSaved(saved);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const upload = (f: File | undefined) => {
    if (!f || !bot) return;
    if (!BOT_IMAGE_TYPES.includes(f.type)) return setError("Use a PNG, JPEG or WebP image.");
    if (f.size > BOT_IMAGE_MAX) return setError("The image is over 256 KiB.");
    putBotImage(bot.id, f).then(() => (bumpBotImage(bot.id), setError(null), reload()), onError);
  };
  const removeImage = () =>
    bot && deleteBotImage(bot.id).then(() => (bumpBotImage(bot.id), reload()), onError);
  const remove = async () => {
    if (bot && await appConfirm(`Delete the bot ${bot.name}? Its runs stay.`)) deleteBot(bot.id).then(onDeleted, onError);
  };
  const preview = { id: bot?.id ?? "", hue: shownHue, face, hasImage: bot?.hasImage ?? false, provider };

  return (
    <form
      className="grid gap-4 px-7 py-[18px] @3xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
      onSubmit={(e) => (e.preventDefault(), void save())}
    >
      <div className={`${CARD} flex min-w-0 flex-col gap-3.5 p-4`}>
        <Field label="NAME" hint={<>in Slack: <code>@Trame {name || "name"}: task</code></>}>
          <TextInput mono value={name} placeholder="my-project" onChange={(e) => setName(e.target.value.toLowerCase())} />
        </Field>
        <Field label="FOLDER" hint="where its runs work" group>
          <div className="flex gap-1.5">
            <TextInput mono value={cwd} placeholder="/path/to/project" onChange={(e) => setCwd(e.target.value)} />
            <Button onClick={() => void choose()} className="inline-flex items-center gap-1.5"><Glyph name="folder" />Choose…</Button>
          </div>
        </Field>
        <Field label="ROLE" hint={`${role.length}/120`}>
          <TextInput
            value={role}
            maxLength={120}
            placeholder="Triages failing checks and opens a fix PR"
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>
        <Field label="DEFAULT AGENT" group>
          <div className="flex flex-wrap gap-1">
            <SegToggle options={PROVIDERS} value={provider} onChange={setProvider} />
          </div>
        </Field>
        {provider === "claude" && (
          <Field label="DEFAULT MODE" hint={MODES.find((m) => m.mode === mode)?.hint} group>
            <div className="flex flex-wrap gap-1">
              <SegToggle<string> options={MODE_OPTIONS} value={mode} onChange={setMode} />
            </div>
          </Field>
        )}
      </div>
      <div className={`${CARD} flex min-w-0 flex-col gap-3.5 self-start p-4`}>
        <div className="flex items-center gap-3">
          <BotAvatar bot={preview} size="l" provider />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{name || "unnamed"}</div>
            <div className="truncate text-[12px] text-ink-soft">{role || folderName(cwd) || "no role yet"}</div>
          </div>
        </div>
        <Field label="FACE" hint={bot?.hasImage ? "the image shows instead" : undefined} group>
          <div className="flex flex-wrap gap-3">
            {FACE_IDS.map((f) => (
              <button
                key={f}
                type="button"
                aria-label={`face ${f.slice(1)}`}
                aria-pressed={face === f}
                className={`grid place-items-center rounded-[30%] p-0.5 ${
                  face === f ? "outline-2 outline-offset-2 outline-copper" : "opacity-80 hover:opacity-100"
                }`}
                onClick={() => setFace(f)}
              >
                <BotAvatar bot={{ ...preview, face: f, hasImage: false }} size="m" />
              </button>
            ))}
          </div>
        </Field>
        <Field label="COLOR" hint={String(shownHue)}>
          <input
            type="range"
            min={0}
            max={359}
            value={shownHue}
            aria-label="hue"
            className={`h-2 w-full cursor-pointer appearance-none rounded-full ${THUMB}`}
            style={{ background: HUE_TRACK }}
            onChange={(e) => setHue(Number(e.target.value))}
          />
        </Field>
        <Field label="IMAGE" hint="PNG, JPEG or WebP · ≤ 256 KiB" group>
          {bot
            ? (
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => file.current?.click()}>{bot.hasImage ? "Replace image…" : "Upload image…"}</Button>
                {bot.hasImage && <Button size="sm" variant="danger" onClick={() => void removeImage()}>Remove</Button>}
                <input
                  ref={file}
                  type="file"
                  accept={BOT_IMAGE_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ""))}
                />
              </div>
            )
            : <span className="text-[11.5px] text-ink-faint">after the bot is created</span>}
        </Field>
      </div>
      <div className="flex items-center gap-2 @3xl:col-span-2">
        {bot && <Button variant="danger" onClick={() => void remove()}>Delete bot</Button>}
        {notice && <span className="text-[11.5px] text-ink-muted">{notice}</span>}
        {error && <ErrorNote className="min-w-0 flex-1">{error}</ErrorNote>}
        <Button type="submit" variant="primary" className="ml-auto" disabled={!valid || busy}>
          {bot ? "Save" : "Create bot"}
        </Button>
      </div>
    </form>
  );
}
