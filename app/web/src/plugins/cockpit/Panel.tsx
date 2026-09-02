// Cockpit plugin panel: the tickets the mapped projects expose, read-only.
// The backend poller owns freshness; rows deep-link into Cockpit.
import { useEffect, useState } from "react";
import { openInBrowser } from "../../api";
import { timeAgo } from "../../ui";

type Ticket = {
  reference: string;
  title: string;
  status: string;
  priority: number;
  scope: string | null;
  standalone_section: string | null;
  updated_at: string;
  mapping: string;
};

type State = {
  configured: boolean;
  baseUrl: string;
  tickets: Ticket[];
  polledAt: string | null;
  errors: { scope: string; error: string }[];
  mirrored: {
    pageId: string;
    scopes: string[];
    created: number;
    updated: number;
    removed: number;
  }[];
};

// Cockpit's execution statuses. Colours reuse the board's status vocabulary so
// a ticket reads the same way a session card does.
const STATUS: Record<string, { label: string; color: string }> = {
  todo: { label: "To do", color: "var(--color-ink-muted)" },
  in_progress: { label: "In progress", color: "var(--color-active)" },
  to_verify: { label: "To verify", color: "var(--color-paused)" },
  to_fix: { label: "To fix", color: "var(--color-blocked)" },
  done: { label: "Done", color: "var(--color-done)" },
  cancelled: { label: "Cancelled", color: "var(--color-done)" },
};

const PRIORITY = ["", "low", "medium", "high", "urgent"];

export function CockpitPanel(
  { onOpenSettings }: { onOpenSettings: () => void },
) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch("/api/plugins/cockpit/state");
    if (r.ok) setState(await r.json());
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/plugins/cockpit/refresh", { method: "POST" });
      if (r.ok) setState(await r.json());
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (!state) {
    return <div className="p-4 text-[12px] text-ink-muted">Loading…</div>;
  }

  // An unmapped plugin is the normal first state, not an error — say what to do
  // rather than showing a blank panel.
  if (!state.configured) {
    return (
      <div className="p-4 text-[12px] text-ink-muted">
        <p className="mb-2">No project mapped yet.</p>
        <p className="mb-3">
          Cockpit tickets only appear for the products or flows you map
          explicitly — nothing is fetched until then.
        </p>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-soft hover:border-chipline"
        >
          ⚙︎ Open settings
        </button>
      </div>
    );
  }

  const byMapping = new Map<string, Ticket[]>();
  for (const t of state.tickets) {
    const list = byMapping.get(t.mapping);
    if (list) list.push(t);
    else byMapping.set(t.mapping, [t]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
          Cockpit
        </span>
        <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
          {state.polledAt && <span>{timeAgo(state.polledAt)}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="rounded-md border border-line px-1.5 py-0.5 hover:border-chipline disabled:opacity-50"
            title="Poll Cockpit now instead of waiting for the interval"
          >
            {busy ? "…" : "↻ Sync now"}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md border border-line px-1.5 py-0.5 hover:border-chipline"
            title="Settings"
          >
            ⚙︎
          </button>
        </div>
      </div>

      {state.mirrored.length > 0 && (
        <div className="border-b border-line px-3 py-1.5 text-[11px] text-ink-muted">
          {state.mirrored.map((m) => (
            <div key={m.pageId}>
              {m.scopes.join(", ")} —{" "}
              {m.created + m.updated + m.removed === 0 ? "nothing to change" : [
                m.created ? `${m.created} new` : "",
                m.updated ? `${m.updated} updated` : "",
                m.removed ? `${m.removed} retired` : "",
              ].filter(Boolean).join(" · ")}
            </div>
          ))}
        </div>
      )}

      {state.errors.length > 0 && (
        <div className="border-b border-line px-3 py-2">
          {state.errors.map((e) => (
            <div key={e.scope} className="text-[11px] text-blocked">
              {e.scope} — {e.error}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {state.tickets.length === 0 && state.errors.length === 0 && (
          <div className="p-4 text-[12px] text-ink-muted">
            Nothing open in the mapped projects.
          </div>
        )}
        {[...byMapping.entries()].map(([mapping, tickets]) => (
          <div key={mapping}>
            <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
              {mapping}
            </div>
            {tickets.map((t) => {
              const s = STATUS[t.status] ?? {
                label: t.status,
                color: "var(--color-ink-muted)",
              };
              return (
                <button
                  key={t.reference}
                  type="button"
                  onClick={() =>
                    openInBrowser(`${state.baseUrl}/cockpit?t=${t.reference}`)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-card"
                >
                  <span
                    className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
                    style={{ background: s.color }}
                    title={s.label}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-mono text-[10.5px] text-ink-muted">
                        {t.reference}
                      </span>
                      {t.priority >= 3 && (
                        <span className="text-[10px] text-copper">
                          {PRIORITY[t.priority]}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink">
                      {t.title}
                    </span>
                    <span className="text-[10px] text-ink-muted">
                      {s.label} · {timeAgo(t.updated_at)}
                    </span>
                  </span>
                  <span className="mt-[3px] text-[11px] text-ink-muted">↗</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
