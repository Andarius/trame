// Database page entry points: the header Connect button / source chip and the empty-state choice.
import { useEffect, useState } from "react";
import { getPlugins, getUdb, setPluginEnabled } from "../../api";
import { appConfirm, Popover, timeAgo } from "../../ui/ui";
import {
  disconnectSource,
  lastLabel,
  notifyChanged,
  pauseSource,
  scheduleLabel,
  type SourceStatus,
  useSources,
} from "./api";
import { SqlSourceDrawer } from "./Drawer";

type Props = { dbId: string; onDone: () => void };

const BTN = "shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11.5px]";

// turn the plugin on (after asking) before the drawer's API calls, which 403 while it is off
async function ensureEnabled(): Promise<boolean> {
  const on = (await getPlugins().catch(() => [])).find((p) => p.id === "sql-source")?.enabled;
  if (on) return true;
  if (!await appConfirm("Turn on the SQL source plugin to fill this database from a query?", "Turn on")) return false;
  await setPluginEnabled("sql-source", true);
  notifyChanged();
  return true;
}

function useFedElsewhere(dbId: string, hasLocal: boolean) {
  const [fed, setFed] = useState(false);
  useEffect(() => {
    getUdb(dbId).then((u) => setFed(u.properties.some((p) => p.config.source))).catch(() => {});
  }, [dbId, hasLocal]);
  return fed && !hasLocal;
}

function SourceChip({ s, busy, onRefresh, onEdit, onDone }: {
  s: SourceStatus;
  busy: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const err = s.last?.error;
  const next = s.next_at && !s.paused
    ? new Date(s.next_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const item = "block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-soft hover:bg-hover hover:text-ink";
  return (
    <span className="relative flex shrink-0 items-center gap-1.5 rounded-md border border-copper/45 py-0.5 pl-2 pr-1 text-[11.5px] text-ink-soft">
      <span className={`h-[7px] w-[7px] rounded-full ${err ? "bg-blocked" : "bg-active"}`} />
      <b className="max-w-[160px] truncate font-semibold text-ink">{s.name || s.id}</b>
      <span className="text-[10.5px] text-ink-muted/70">
        {s.paused ? "paused" : s.last ? timeAgo(s.last.refreshed_at) : "never"}
      </span>
      <button
        type="button"
        title="Refresh now"
        disabled={busy || s.running}
        className="rounded border border-chipline px-1.5 text-ink-soft hover:text-ink disabled:opacity-50"
        onClick={onRefresh}
      >
        {busy || s.running ? "…" : "↻"}
      </button>
      <button type="button" title="Source menu" aria-label="Source menu" className="px-1 text-ink-muted hover:text-ink" onClick={() => setMenu((v) => !v)}>
        ▾
      </button>
      {menu && (
        <Popover onClose={() => setMenu(false)} className="left-auto right-0 min-w-[240px]">
          <button type="button" className={item} onClick={() => (setMenu(false), onRefresh())}>↻ Refresh now</button>
          <button type="button" className={item} onClick={() => (setMenu(false), onEdit())}>✎ Edit query &amp; schedule…</button>
          <button
            type="button"
            className={item}
            onClick={() => (setMenu(false), pauseSource(s.id, !s.paused).then(onDone).catch(() => {}))}
          >
            {s.paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <p className={`m-0 px-2.5 py-1 text-[10.5px] ${err ? "text-blocked" : "text-ink-muted/70"}`}>
            {err ?? `${scheduleLabel(s.interval_min)}${next ? ` · next ${next}` : ""} · last: ${lastLabel(s.last)}`}
          </p>
          <hr className="my-1 border-line" />
          <button
            type="button"
            className={`${item} text-blocked/80 hover:text-blocked`}
            onClick={async () => {
              setMenu(false);
              if (await appConfirm(`Disconnect "${s.name}"? Its rows stay; the columns become editable.`, "Disconnect")) {
                await disconnectSource(s.id).catch(() => {});
                onDone();
              }
            }}
          >
            Disconnect (keeps the rows)
          </button>
        </Popover>
      )}
    </span>
  );
}

// opens the drawer after making sure the plugin is on
function useDrawer({ dbId, onDone }: Props) {
  const [drawer, setDrawer] = useState<{ editId?: string } | null>(null);
  const open = async (editId?: string) => {
    if (await ensureEnabled()) setDrawer({ editId });
  };
  const node = drawer && (
    <SqlSourceDrawer dbId={dbId} editId={drawer.editId} onClose={() => setDrawer(null)} onDone={onDone} />
  );
  return { open, node };
}

export function SqlSourceDatabaseActions(props: Props) {
  const { dbId, onDone } = props;
  const { sources, busy, refresh } = useSources(dbId);
  const { open, node } = useDrawer(props);
  const fedElsewhere = useFedElsewhere(dbId, !!sources?.length);
  return (
    <>
      {sources?.length
        ? sources.map((s) => (
          <SourceChip
            key={s.id}
            s={s}
            busy={busy === s.id}
            onRefresh={() => refresh(s.id, onDone)}
            onEdit={() => open(s.id)}
            onDone={() => (notifyChanged(), onDone())}
          />
        ))
        : fedElsewhere
        ? (
          <span
            className={`${BTN} border-line text-ink-muted`}
            title="These columns are filled by a SQL source that this device does not run"
          >
            {sources === null ? "⇣ filled by a SQL source" : "⇣ fed from another device"}
          </span>
        )
        : (
          <button type="button" className={`${BTN} border-copper/55 text-copper hover:bg-copper/10`} onClick={() => open()}>
            ⇣ Connect
          </button>
        )}
      {node}
    </>
  );
}

export function SqlSourceDatabaseEmpty(props: Props) {
  const { open, node } = useDrawer(props);
  return (
    <>
      <button
        type="button"
        className="flex flex-col gap-0.5 rounded-lg border border-copper bg-copper/5 px-3 py-2.5 text-left"
        onClick={() => open()}
      >
        <b className="text-[12px] text-copper">⇣ Fill from a SQL query</b>
        <span className="text-[11px] text-ink-muted">Run a read-only query and keep this database up to date.</span>
      </button>
      {node}
    </>
  );
}
