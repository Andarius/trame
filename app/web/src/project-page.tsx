import { type ReactNode, useEffect, useState } from "react";
import { type PageChild, type Session, setStatus } from "./api";
import { getPrInfo } from "./chips";
import { TagChips } from "./ui";

export { repoTitle } from "./repo-title.ts";

export const RepoChip = ({ repo }: { repo: string }) => (
  <span className="shrink-0 rounded bg-card px-1 font-mono text-[10px] text-ink-muted">{repo}</span>
);

// a page's todo progress: bar + done/total
export const TodoBar = ({ done, total }: { done: number; total: number }) => (
  <span
    className="inline-flex items-center gap-1.5 pl-1 font-mono text-[11px] tabular-nums text-ink-faint"
    title={`${done} of ${total} todos done`}
  >
    <span className="inline-block h-1 w-10 overflow-hidden rounded bg-line">
      <span className="block h-full rounded bg-live" style={{ width: `${(done / total) * 100}%` }} />
    </span>
    {done}/{total}
  </span>
);

// open cards whose PR is already merged/closed — same signal as StaleChip, lifted to the page
export function useFinishedCards(open: Session[]): Set<string> {
  const [done, setDone] = useState<Set<string>>(new Set());
  const key = open.map((s) => `${s.id}:${s.pr_url ?? ""}`).join(",");
  useEffect(() => {
    let alive = true;
    Promise.all(
      open.filter((s) => s.pr_url).map(async (s) => {
        const { state } = await getPrInfo(s.pr_url as string).catch(() => ({ state: "unknown" }));
        return state === "merged" || state === "closed" ? s.id : null;
      }),
    ).then((ids) => alive && setDone(new Set(ids.filter((i): i is string => i !== null))));
    return () => {
      alive = false;
    };
  }, [key]);
  return done;
}

export function FinishedStrip({ cards, onOpen }: { cards: Session[]; onOpen: (id: string) => void }) {
  if (!cards.length) return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-[#e3c567]/12 px-2 py-1.5">
      <span className="text-[11px] font-semibold text-[#c9a227]">
        {cards.length > 1 ? `${cards.length} cards look` : "1 card looks"} finished — PR merged or closed
      </span>
      {cards.map((s) => (
        <div key={s.id} className="flex items-center gap-2 text-[12px]">
          <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen(s.id)}>
            {s.title}
          </button>
          <button
            type="button"
            title="mark done"
            className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[#c9a227] hover:bg-[#e3c567]/25"
            onClick={() => setStatus(s.id, "done")}
          >
            ✓ done
          </button>
        </div>
      ))}
    </div>
  );
}

const DAY = 86_400_000;

// a tag most rows share moves to the section header (shown once) and off the rows
function sharedTag(rows: PageChild[]): string | null {
  if (rows.length < 3) return null;
  const n = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) n.set(t, (n.get(t) ?? 0) + 1);
  const [top] = [...n].sort((a, b) => b[1] - a[1]);
  return top && top[1] > rows.length / 2 ? top[0] : null;
}

const byRecent = (a: PageChild, b: PageChild) => b.updated_at.localeCompare(a.updated_at);

// A project's children: stories bucketed by recency, then docs, archived folded last.
// `shown` stories already appear in `top` (in progress) and are skipped here.
export function ProjectChildren(
  { pages, shown, row, top }: {
    pages: PageChild[];
    shown: Set<string>;
    top?: ReactNode;
    row: (c: PageChild, hideTag: string | null) => ReactNode;
  },
) {
  const [openOlder, setOpenOlder] = useState(false);
  const [openArchived, setOpenArchived] = useState(false);
  const [openOldDocs, setOpenOldDocs] = useState(false);
  const live = pages.filter((c) => c.status !== "archived" && !shown.has(c.id)).sort(byRecent);
  const archived = pages.filter((c) => c.status === "archived").sort(byRecent);
  const stories = live.filter((c) => c.kind === "story");
  const docs = live.filter((c) => c.kind !== "story");
  const now = Date.now();
  const age = (c: PageChild) => now - Date.parse(c.updated_at);
  const buckets: [string, PageChild[]][] = [
    ["Today", stories.filter((c) => age(c) < DAY)],
    ["This week", stories.filter((c) => age(c) >= DAY && age(c) < 7 * DAY)],
    ["Older", stories.filter((c) => age(c) >= 7 * DAY)],
  ];
  const storyTag = sharedTag(stories);
  const docTag = sharedTag(docs);
  const header = (label: string, count: number, tag: string | null, toggle?: () => void, open?: boolean) => (
    <div className="mt-2 flex items-center gap-1.5 px-1.5 first:mt-0">
      <button
        type="button"
        disabled={!toggle}
        onClick={toggle}
        className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70 enabled:hover:text-ink-soft"
      >
        {toggle ? (open ? "▾ " : "▸ ") : ""}
        {label.toUpperCase()} <span className="font-normal text-ink-faint">· {count}</span>
      </button>
      {tag && (
        <span className="flex items-center gap-1 text-[10.5px] text-ink-faint">
          mostly <TagChips keys={[tag]} />
        </span>
      )}
    </div>
  );
  return (
    <>
      {top}
      {buckets.map(([label, rows]) => {
        if (!rows.length) return null;
        const fold = label === "Older";
        return (
          <div key={label} className="flex flex-col gap-0.5">
            {header(label, rows.length, label === "Today" ? storyTag : null, fold ? () => setOpenOlder((o) => !o) : undefined, openOlder)}
            {(!fold || openOlder) && rows.map((c) => row(c, storyTag))}
          </div>
        );
      })}
      {docs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {header("Docs", docs.length, docTag)}
          {docs.filter((c) => age(c) < 7 * DAY).map((c) => row(c, docTag))}
        </div>
      )}
      {docs.some((c) => age(c) >= 7 * DAY) && (
        <div className="flex flex-col gap-0.5">
          {header("Older docs", docs.filter((c) => age(c) >= 7 * DAY).length, null, () => setOpenOldDocs((o) => !o), openOldDocs)}
          {openOldDocs && docs.filter((c) => age(c) >= 7 * DAY).map((c) => row(c, docTag))}
        </div>
      )}
      {archived.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {header("Archived", archived.length, null, () => setOpenArchived((o) => !o), openArchived)}
          {openArchived && archived.map((c) => row(c, null))}
        </div>
      )}
    </>
  );
}
