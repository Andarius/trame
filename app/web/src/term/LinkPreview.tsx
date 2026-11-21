// Hover cards for links in a terminal: a PR's state, or the card / page a Trame link opens.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getPage, getUdb } from "../api";
import { PR_HREF, PrPreview } from "../md/chips";
import { StatusDot, statusStyle, timeAgo } from "../ui/ui";
import { trameHttpTarget, trameScheme, type TrameTarget } from "./trame-links";

export type LinkHover = { url: string; x: number; y: number };

export const trameTarget = (url: string) =>
  trameScheme(url) ?? trameHttpTarget(url, location.origin);
// worth a hover card: a PR, or a Trame card / page / database
export const previewable = (url: string) =>
  PR_HREF.test(url) || /^(card|page|db)$/.test(trameTarget(url)?.kind ?? "");

type Summary = {
  kind: string;
  title: string;
  status?: string;
  context?: string;
  detail?: string;
  foot?: string;
} | { missing: true };

type CardJson = {
  title: string;
  status: string;
  next_step: string | null;
  branch: string | null;
  last_touched: string | null;
  project: { name: string } | null;
  story: { title: string } | null;
};

type Linked = Extract<TrameTarget, { id: string }>;

const cache = new Map<string, Promise<Summary>>();
function summary(t: Linked): Promise<Summary> {
  const key = `${t.kind}:${t.id}`;
  let p = cache.get(key);
  if (!p) {
    const load = async (): Promise<Summary> => {
      if (t.kind === "card") {
        const r = await fetch(`/api/sessions/${t.id}`);
        if (!r.ok) return { missing: true };
        const c = (await r.json()) as CardJson;
        return {
          kind: "card",
          title: c.title,
          status: c.status,
          context: [c.project?.name, c.story?.title].filter(Boolean).join(
            " › ",
          ),
          detail: c.next_step ?? undefined,
          foot: [c.last_touched && timeAgo(c.last_touched), c.branch].filter(
            Boolean,
          ).join(" · "),
        };
      }
      if (t.kind === "page") {
        const pg = await getPage(t.id);
        if (!pg?.id) return { missing: true };
        return {
          kind: pg.kind || "page",
          title: pg.title || "Untitled",
          detail: pg.brief || undefined,
          foot: [
            pg.children.length && `${pg.children.length} subpages`,
            pg.sessions.length && `${pg.sessions.length} cards`,
          ]
            .filter(Boolean).join(" · "),
        };
      }
      const d = await getUdb(t.id);
      return d?.db ? { kind: "database", title: d.db.name } : { missing: true };
    };
    p = load().catch(() => ({ missing: true }) as Summary);
    cache.set(key, p);
    // a card changes while you work: refetch on the next hover after a short while
    setTimeout(() => cache.delete(key), 15_000);
  }
  return p;
}

function TrameLinkPreview(
  { kind, id, x, y }: Linked & { x: number; y: number },
) {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    let live = true;
    void summary({ kind, id }).then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, [kind, id]);
  const w = 320;
  const left = x + w + 20 > innerWidth ? x - w - 12 : x + 12;
  const top = y + 150 > innerHeight ? y - 150 : y + 16;
  const st = s && !("missing" in s) && s.status ? statusStyle(s.status) : null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 flex flex-col gap-1 rounded-md border border-chipline bg-panel-modal px-3 py-2 text-[12px] shadow-lg shadow-black/40"
      style={{ left: Math.max(4, left), top: Math.max(4, top), width: w }}
    >
      {!s
        ? <span className="text-ink-muted">loading…</span>
        : "missing" in s
        ? <span className="text-ink-muted">This {kind} no longer exists.</span>
        : (
          <>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              {st && <StatusDot status={s.status!} />}
              {st && <span style={{ color: st.color }}>{st.label}</span>}
              {!st && <span className="uppercase tracking-wide">{s.kind}</span>}
              {s.context && (
                <span className="min-w-0 flex-1 truncate text-right">
                  {s.context}
                </span>
              )}
            </span>
            <span className="line-clamp-2 font-medium text-ink">{s.title}</span>
            {s.detail && (
              <span className="line-clamp-3 text-[11.5px] text-ink-soft">
                {s.detail}
              </span>
            )}
            {s.foot && (
              <span className="truncate text-[11px] text-ink-faint">
                {s.foot}
              </span>
            )}
          </>
        )}
    </div>,
    document.body,
  );
}

export function LinkPreview({ url, x, y }: LinkHover) {
  if (PR_HREF.test(url)) return <PrPreview url={url} x={x} y={y} />;
  const t = trameTarget(url);
  return t && "id" in t
    ? <TrameLinkPreview kind={t.kind} id={t.id} x={x} y={y} />
    : null;
}
