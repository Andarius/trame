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

type Synced = {
  pageId: string;
  ref: string;
  title: string;
  parentTitle: string | null;
  updatedAt: string;
};

type Pending = {
  pageId: string;
  title: string;
  parentTitle: string | null;
  tagLabel: string;
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
  filed: { title: string; reference: string }[];
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

const ticketUrl = (baseUrl: string, ref: string) =>
  `${baseUrl.replace(/\/+$/, "")}/ticket/${encodeURIComponent(ref)}`;

export function CockpitPanel(
  { onOpenSettings, onOpenPage }: {
    onOpenSettings: () => void;
    onOpenPage: (id: string) => void;
  },
) {
  const [state, setState] = useState<State | null>(null);
  const [synced, setSynced] = useState<Synced[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [filing, setFiling] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ pageId: string; detail: string }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch("/api/plugins/cockpit/state");
    if (r.ok) setState(await r.json());
    // Separate call: this one reads pages, not the poller's memory, so it is
    // right even when the last poll failed.
    const s = await fetch("/api/plugins/cockpit/synced");
    if (s.ok) {
      const d = await s.json();
      setSynced((d.pages ?? []) as Synced[]);
      setPending((d.pending ?? []) as Pending[]);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/plugins/cockpit/refresh", { method: "POST" });
      if (r.ok) setState(await r.json());
      await load();
    } finally {
      setBusy(false);
    }
  };

  // One page at a time, sequentially: each is a row in a shared tracker, and a
  // half-failed batch is far easier to sort out when the order is knowable.
  const file = async (ids: string[]) => {
    const errs: { pageId: string; detail: string }[] = [];
    for (const pageId of ids) {
      setFiling(pageId);
      try {
        const r = await fetch("/api/plugins/cockpit/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageId }),
        });
        const d = await r.json();
        if (d.error || !d.reference) {
          errs.push({ pageId, detail: d.error ?? "failed" });
        }
      } catch (e) {
        errs.push({ pageId, detail: String((e as Error)?.message ?? e) });
      }
    }
    setFiling(null);
    setFailed(errs);
    await load();
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (!state) {
    return <div className="p-4 text-[12px] text-ink-muted">Loading…</div>;
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
            {
              /* NOT "Sync now": Trame's own hub-sync button carries that
                label in the page header just above, and two identical
                buttons doing different things is worse than a vague one. */
            }
            {busy ? "…" : "↻ Poll Cockpit"}
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

      {state.filed?.length > 0 && (
        <div className="border-b border-line px-3 py-1.5 text-[11px] text-ink-muted">
          Filed {state.filed.map((f, i) => (
            <span key={f.reference}>
              {i > 0 && ", "}
              <span className="text-ink-soft">{f.title}</span>{" "}
              <span className="font-mono text-[10.5px]">{f.reference}</span>
            </span>
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
        {
          /* `configured` reflects the LAST POLL, not the settings: mapping a
            project leaves it false until the next pass. So this branch keeps
            the header — and its refresh — reachable, otherwise the panel would
            deny being configured with no way to prove itself wrong. */
        }
        {!state.configured && (
          <div className="p-4 text-[12px] text-ink-muted">
            <p className="mb-2">No project mapped yet.</p>
            <p className="mb-3">
              Cockpit tickets only appear for the products or flows you map
              explicitly — nothing is fetched until then. Just mapped one? Hit ↻
              Sync now.
            </p>
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-soft hover:border-chipline"
            >
              ⚙︎ Open settings
            </button>
          </div>
        )}
        {state.configured && pending.length > 0 && (
          <div className="border-b border-line pb-2">
            <div className="flex items-baseline justify-between px-3 pt-3 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
                Filing next pass
              </span>
              <button
                type="button"
                disabled={filing !== null}
                onClick={() => file(pending.map((p) => p.pageId))}
                className="rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-chipline disabled:opacity-50"
                title="File every page listed here as a Cockpit ticket"
              >
                {filing ? "…" : `⌗ File all ${pending.length}`}
              </button>
            </div>
            {pending.map((p) => {
              const err = failed.find((f) => f.pageId === p.pageId);
              return (
                <div
                  key={p.pageId}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 hover:bg-card"
                >
                  <button
                    type="button"
                    onClick={() => onOpenPage(p.pageId)}
                    className="min-w-0 flex-1 text-left"
                    title="Open the page in Trame"
                  >
                    <span className="block truncate text-[12px] text-ink">
                      {p.title || "Untitled"}
                    </span>
                    <span className="text-[10px] text-ink-muted">
                      {p.parentTitle ? `${p.parentTitle} · ` : ""}
                      {p.tagLabel}
                    </span>
                    {err && (
                      <span className="block text-[10px] text-blocked">
                        {err.detail}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={filing !== null}
                    onClick={() => file([p.pageId])}
                    className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-chipline disabled:opacity-50"
                  >
                    {filing === p.pageId ? "…" : "⌗ File it"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {state.configured && (
          <div className="border-b border-line pb-2">
            <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
              Synced pages
            </div>
            {synced.length === 0
              ? (
                <p className="px-3 py-1 text-[11px] text-ink-muted">
                  No page is linked to a ticket yet. Tag a story with its
                  mapping&rsquo;s <code>cockpit:</code>{" "}
                  tag and the page offers to file itself.
                </p>
              )
              : synced.map((p) => (
                <div
                  key={p.pageId}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 hover:bg-card"
                >
                  <button
                    type="button"
                    onClick={() => onOpenPage(p.pageId)}
                    className="min-w-0 flex-1 text-left"
                    title="Open the page in Trame"
                  >
                    <span className="block truncate text-[12px] text-ink">
                      {p.title || "Untitled"}
                    </span>
                    <span className="text-[10px] text-ink-muted">
                      {p.parentTitle ? `${p.parentTitle} · ` : ""}
                      {timeAgo(p.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openInBrowser(ticketUrl(state.baseUrl, p.ref))}
                    className="shrink-0 font-mono text-[10.5px] text-ink-muted hover:text-ink-soft"
                    title="Open the ticket in Cockpit"
                  >
                    {p.ref} ↗
                  </button>
                </div>
              ))}
          </div>
        )}
        {state.configured && state.tickets.length === 0 &&
          state.errors.length === 0 && (
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
                    openInBrowser(ticketUrl(state.baseUrl, t.reference))}
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
