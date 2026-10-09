import type { BoardData, PageChild, Session } from "../api";
import {
  dblOpen,
  EntityIcon,
  pageGlyph,
  type pagesById,
  SECTION_LABEL,
  SegToggle,
  sessionTagKeys,
  StatusDot,
  statusStyle,
  TagChips,
  ProgressBar,
} from "../ui/ui";
import { LiveAgentChip, type useAgents } from "../agents/agents";
import { FRONTEND_PLUGINS } from "../plugins";
import { tagPriority } from "../sessions/SessionSort";
import { QueryBox } from "../sessions/SessionBar";
import { filterSessions } from "../query";
import { FinishedStrip, RepoChip, repoTitle, SessionRow, TodoBar, type useFinishedCards } from "./project-page";

export type SessionsByStory = { story: PageChild; list: Session[] }[];

export function SessionsPanel(
  {
    atTop,
    sessions,
    done,
    sessionFilter,
    setSessionFilter,
    finishedCards,
    finished,
    sessionsByStory,
    ungroupedSessions,
    onOpenSession,
  }: {
    atTop: boolean;
    sessions: Session[];
    done: number;
    sessionFilter: "active" | "done";
    setSessionFilter: (v: "active" | "done") => void;
    finishedCards: Session[];
    finished: ReturnType<typeof useFinishedCards>;
    sessionsByStory: SessionsByStory;
    ungroupedSessions: Session[];
    onOpenSession: (id: string, full?: boolean) => void;
  },
) {
  const sessionRow = (s: Session) => <SessionRow key={s.id} s={s} onOpen={onOpenSession} />;
  const shownSession = (s: Session) =>
    statusStyle(s.status).terminal === (sessionFilter === "done") && !(sessionFilter === "active" && finished.has(s.id));
  return (
    <div
      className={`flex flex-col gap-1 border-line-soft ${
        atTop ? "border-b pb-3" : "border-t pt-3"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`mr-1 ${SECTION_LABEL}`}>
          SESSIONS
        </span>
        <SegToggle
          options={[
            { value: "active", label: `Active ${sessions.length - done}` },
            { value: "done", label: `Done ${done}` },
          ]}
          value={sessionFilter}
          onChange={setSessionFilter}
        />
      </div>
      {sessionFilter === "active" && <FinishedStrip cards={finishedCards} onOpen={onOpenSession} />}
      {sessionsByStory.filter(({ list }) => list.some(shownSession)).map(({ story, list }) => {
        const doneInStory = list.filter((s) =>
          statusStyle(s.status).terminal
        ).length;
        const shown = list.filter(shownSession);
        // a story with one card is one row: the story, then that card's repo/branch/status
        if (shown.length === 1) {
          const s = shown[0];
          const rt = repoTitle(s);
          return (
            <div
              key={story.id}
              onClick={() => onOpenSession(s.id)}
              title={s.title}
              onDoubleClick={dblOpen(() => onOpenSession(s.id, true))}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-hover"
            >
              <EntityIcon icon={story.icon} fallback={pageGlyph("story", story.mark_role)} className="text-[11px] text-ink-muted" />
              <span className="shrink-0 text-[12px] font-semibold text-ink-soft">{story.title || "Untitled"}</span>
              <span className="min-w-0 truncate text-[11px] text-ink-muted">{rt.title}</span>
              <span className="flex-1" />
              {rt.repo && <RepoChip repo={rt.repo} />}
              {list.length > 1 && <span className="shrink-0 whitespace-nowrap text-[10px] text-ink-muted">{doneInStory} / {list.length}</span>}
              <StatusDot status={s.status} size={7} />
              <span className="w-[42px] text-right text-[10px] text-ink-muted/70">{statusStyle(s.status).label}</span>
            </div>
          );
        }
        return (
          <div
            key={story.id}
            className="flex flex-col gap-0.5 pt-2 first:pt-0"
          >
            <div className="flex items-center gap-2 px-1">
              <EntityIcon
                icon={story.icon}
                fallback={pageGlyph("story", story.mark_role)}
                className="text-[11px] text-ink-muted"
              />
              <span className="text-[12px] font-semibold text-ink-soft">
                {story.title || "Untitled"}
              </span>
              <ProgressBar value={doneInStory / list.length} color="bg-copper" className="w-[60px]" />
              <span className="text-[10px] text-ink-muted">
                {doneInStory} / {list.length}
              </span>
            </div>
            <div className="flex flex-col pl-1">
              {shown.map(sessionRow)}
            </div>
          </div>
        );
      })}
      {ungroupedSessions.filter(shownSession).map(sessionRow)}
      {!sessions.some(shownSession) && (
        <span className="py-1 text-[11.5px] text-ink-muted">
          {sessions.length === 0 ? "no sessions yet" : `no ${sessionFilter} sessions`}
        </span>
      )}
    </div>
  );
}

export function groupInProgress(
  { sessionsByStory, ungroupedSessions, finished, board, cardQuery, storyOrder, byId }: {
    sessionsByStory: SessionsByStory;
    ungroupedSessions: Session[];
    finished: ReturnType<typeof useFinishedCards>;
    board: BoardData;
    cardQuery: string;
    storyOrder: "touched" | "priority";
    byId: ReturnType<typeof pagesById>;
  },
) {
  // a project lists its user stories with open cards first, those cards nested under them
  const openOf = (list: Session[]) =>
    filterSessions(list.filter((s) => !statusStyle(s.status).terminal && !finished.has(s.id)), board, cardQuery);
  const lastTouch = (list: Session[]) => list.reduce((m, s) => (s.last_touched > m ? s.last_touched : m), "");
  // priority = the most urgent `pN` tag on a card (its story's tags included); untagged last
  const prio = (list: Session[]) => tagPriority(list.flatMap((s) => sessionTagKeys(s, byId))) ?? Infinity;
  const byPrio = (list: Session[]) =>
    storyOrder === "priority" ? [...list].sort((a, b) => prio([a]) - prio([b])) : list;
  const inProgress = sessionsByStory
    .map((g) => ({ ...g, open: byPrio(openOf(g.list)) }))
    .filter((g) => g.open.length > 0)
    .sort((a, b) =>
      (storyOrder === "priority" ? prio(a.open) - prio(b.open) : 0) ||
      lastTouch(b.open).localeCompare(lastTouch(a.open))
    );
  const looseOpen = byPrio(openOf(ungroupedSessions));
  const storiesInSessions = new Set(inProgress.map(({ story }) => story.id));
  return { inProgress, looseOpen, storiesInSessions };
}

const FOLD = 3;

export function InProgressBlock(
  {
    finishedCards,
    inProgress,
    looseOpen,
    cardQuery,
    setCardQuery,
    storyOrder,
    setStoryOrder,
    unfoldedStories,
    setUnfoldedStories,
    onOpenPage,
    onOpenSession,
  }: {
    finishedCards: Session[];
    inProgress: ReturnType<typeof groupInProgress>["inProgress"];
    looseOpen: Session[];
    cardQuery: string;
    setCardQuery: (v: string) => void;
    storyOrder: "touched" | "priority";
    setStoryOrder: (v: "touched" | "priority") => void;
    unfoldedStories: Set<string>;
    setUnfoldedStories: (f: (prev: Set<string>) => Set<string>) => void;
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string, full?: boolean) => void;
  },
) {
  const sessionRow = (s: Session) => <SessionRow key={s.id} s={s} onOpen={onOpenSession} />;
  return (
    <>
      <FinishedStrip cards={finishedCards} onOpen={onOpenSession} />
      {(inProgress.length > 0 || cardQuery) && (
        <div className="flex items-center gap-3">
          <span className={`shrink-0 px-1.5 ${SECTION_LABEL}`}>
            IN PROGRESS <span className="font-normal text-ink-faint">· {inProgress.length}</span>
            <button
              type="button"
              title="order stories by last activity or by priority tag (p1, p2…)"
              onClick={() => {
                const next = storyOrder === "priority" ? "touched" : "priority";
                setStoryOrder(next);
              }}
              className="ml-2 font-normal tracking-normal text-ink-faint hover:text-ink-soft"
            >
              {storyOrder === "priority" ? "by priority" : "by activity"}
            </button>
          </span>
          <QueryBox query={cardQuery} onQuery={setCardQuery} onClear={() => setCardQuery("")} />
        </div>
      )}
      {inProgress.map(({ story, list, open }) => {
        const doneN = list.filter((s) => statusStyle(s.status).terminal).length;
        const unfolded = unfoldedStories.has(story.id);
        return (
          <div key={story.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => onOpenPage(story.id)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] font-medium text-ink hover:bg-panel"
            >
              <EntityIcon icon={story.icon} fallback={pageGlyph("story", story.mark_role)} className="text-ink-muted" />
              <span className="min-w-0 truncate">{story.title || "Untitled"}</span>
              <TagChips keys={story.tags} />
              <span className="flex-1" />
              <ProgressBar value={doneN / list.length} color="bg-active" className="w-[60px] shrink-0" />
              <span className="w-[56px] shrink-0 text-right text-[10.5px] font-normal text-ink-muted">
                {doneN} / {list.length}
              </span>
            </button>
            <div className="ml-[22px] flex flex-col border-l border-line-soft pl-2">
              {(unfolded ? open : open.slice(0, FOLD)).map(sessionRow)}
              {open.length > FOLD && (
                <button
                  type="button"
                  onClick={() =>
                    setUnfoldedStories((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(story.id)) next.add(story.id);
                      return next;
                    })}
                  className="self-start px-1 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft"
                >
                  {unfolded ? "▾ fewer" : `▸ ${open.length - FOLD} more`}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {looseOpen.length > 0 && (
        <div className="flex flex-col">
          <span className={`mt-2 px-1.5 ${SECTION_LABEL}`}>
            NO USER STORY <span className="font-normal text-ink-faint">· {looseOpen.length}</span>
          </span>
          <div className="ml-[22px] flex flex-col pl-2">{looseOpen.map(sessionRow)}</div>
        </div>
      )}
    </>
  );
}

export function CardsSection(
  { sessions, pageChildren, showDone, onToggleDone, live, recent, onOpenSession }: {
    sessions: Session[];
    pageChildren: PageChild[];
    showDone: boolean;
    onToggleDone: () => void;
    live: ReturnType<typeof useAgents>["live"];
    recent: ReturnType<typeof useAgents>["recent"];
    onOpenSession: (id: string, full?: boolean) => void;
  },
) {
  return (
            <div className="flex flex-col gap-0.5 border-b border-line-soft pb-3">
              <span className={`mb-1 ${SECTION_LABEL}`}>CARDS</span>
              {/* open cards first; done ones fold behind a toggle so a long-lived story stays readable */}
              {[
                ...sessions.filter((s) => !statusStyle(s.status).terminal),
                ...(showDone ? sessions.filter((s) => statusStyle(s.status).terminal) : []),
              ].map((s) => {
                const spec = pageChildren.find((c) => c.id === s.specs_page_id);
                const agents = live.filter(({ a }) =>
                  a.session_id === s.id || (!!s.specs_page_id && a.page_id === s.specs_page_id)
                );
                const done = statusStyle(s.status).terminal;
                return (
                  <div
                    key={s.id}
                    title="open the session"
                    // the full session view: its specs, worklog and links in one place
                    onClick={() => onOpenSession(s.id, true)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-panel"
                  >
                    <StatusDot status={s.status} size={7} />
                    {spec?.icon && <EntityIcon icon={spec.icon} className="text-[13px]" />}
                    <span className={done ? "text-ink-muted line-through decoration-ink-faint" : "text-ink-soft"}>
                      {s.title}
                    </span>
                    {FRONTEND_PLUGINS.map((p) => p.CardBadge && <p.CardBadge key={p.id} sessionId={s.id} />)}
                    {(() => {
                      // the session working this card, by its own name (live or recently seen)
                      const name = recent.find((a) => a.session_id === s.id && a.name)?.name;
                      return name && <span className="font-mono text-[11px] text-ink-faint">{name}</span>;
                    })()}
                    {/* the card's tags and its spec page's */}
                    {(() => {
                      const keys = [...new Set([...(s.tags ?? []), ...(spec?.tags ?? [])])];
                      return keys.length > 0 && <TagChips keys={keys} />;
                    })()}
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                      {agents.map((l) => <LiveAgentChip key={l.a.session_id} {...l} />)}
                      {!!spec?.todos && <TodoBar done={spec.todos_done ?? 0} total={spec.todos} />}
                      <span className="w-[64px] text-right text-[10.5px] text-ink-muted/70">
                        {statusStyle(s.status).label}
                      </span>
                    </span>
                  </div>
                );
              })}
              {sessions.some((s) => statusStyle(s.status).terminal) && (
                <button
                  type="button"
                  onClick={() => onToggleDone()}
                  className="self-start rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                >
                  {showDone ? "▾ Hide" : "▸"} {sessions.filter((s) => statusStyle(s.status).terminal).length} done
                </button>
              )}
            </div>
  );
}
