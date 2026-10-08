import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import {
  addSessionLink,
  attachUdbToPage,
  type Block,
  type BoardData,
  createComment,
  createPage,
  createUdb,
  deleteComment,
  deletePage,
  getIdentity,
  getPage,
  getPresence,
  listComments,
  type PageChild,
  type PageComment,
  type PageDetail,
  pingPresence,
  type Presence,
  type UdbMeta,
  updateComment,
  updatePage,
} from "./api";
import {
  BOOL_CODEC,
  enumCodec,
  useLocalStorage,
  appConfirm,
  ClientChip,
  EntityIcon,
  inSubtree,
  pageGlyph,
  pagesById,
  Popover,
  SECTION_LABEL,
  Select,
  statusStyle,
  storyOf,
} from "./ui";
import { PageActivityChip } from "./md-activity";
import { blocksToMarkdown } from "./page-serialize";
import { IconPicker } from "./udb/cells";
import { useFocusedBlock } from "./due";
import { PAGE_STATUSES } from "../../../core/page-status.ts";
import { useAgents } from "./agents";
import { DatabaseView } from "./udb/DatabaseTable";
import { FRONTEND_PLUGINS } from "./plugins";
import { markRoleOf } from "../../../core/mark-roles.ts";
import { PageRow, ProjectChildren, useFinishedCards } from "./project-page";
import { genId, ensureIds, PROJECT_COLORS } from "./page-ids";
import { isText } from "./editor-text";
import { PresenceBar, StartWatcherButton } from "./PresenceBar";
import {
  type CommentOps,
  type CommentMode,
  COMMENT_MODE_KEY,
  STORY_ORDER_KEY,
  PANEL_OPEN_KEY,
  openKey,
  loadOpenThreads,
  isAgent,
  answeredIn,
  anchorQuoteOf,
  RowNote,
  CommentItem,
  AddNote,
} from "./comments";
import { BlockEditor } from "./BlockEditor";
import { SessionsPanel, groupInProgress, InProgressBlock, CardsSection } from "./PageSessions";
import { PageHeaderMenu, MarkdownPanel } from "./PageHeaderMenu";

export function Page(
  {
    pageId,
    board,
    udbs,
    onOpenPage,
    onOpenSession,
    onOpenClient,
    onOpenReport,
    onChanged,
  }: {
    pageId: string;
    board: BoardData;
    udbs: UdbMeta[];
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string, full?: boolean) => void;
    onOpenClient: (id: string) => void;
    onOpenReport: (path: string) => void;
    onChanged: () => void; // sidebar tree cares about title/icon/structure changes
  },
) {
  const [page, setPage] = useState<PageDetail | null>(null);
  // 🔗 on a list item: pick the session to link it to
  const [linkPick, setLinkPick] = useState<
    { blockId: string; item: string } | null
  >(null);
  const { live: liveAgentsAll, recent: recentAgents } = useAgents();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const focused = useFocusedBlock(blocks);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<"active" | "done">("active");
  const [showDoneCards, setShowDoneCards] = useState(false);
  const [unfoldedStories, setUnfoldedStories] = useState<Set<string>>(new Set());
  const [cardQuery, setCardQuery] = useState("");
  const [storyOrder, setStoryOrder] = useLocalStorage<"touched" | "priority">(STORY_ORDER_KEY, "touched", enumCodec(["touched", "priority"]));
  const [showArchivedDocs, setShowArchivedDocs] = useState(false);
  const [commentMode, setCommentMode] = useLocalStorage<CommentMode>(COMMENT_MODE_KEY, "inline", enumCodec(["inline", "panel"]));
  const [openThreads, setOpenThreads] = useState<Set<string>>(() =>
    loadOpenThreads(pageId)
  );
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useLocalStorage(PANEL_OPEN_KEY, false, BOOL_CODEC);
  // set + persist open threads together, keyed by the current page (no cross-page race)
  const putOpenThreads = (v: Set<string> | ((p: Set<string>) => Set<string>)) =>
    setOpenThreads((p) => {
      const next = typeof v === "function" ? v(p) : v;
      localStorage.setItem(openKey(pageId), JSON.stringify([...next]));
      return next;
    });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const [idCopied, setIdCopied] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [mdOpen, setMdOpen] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  // presence: heartbeat that I'm here + poll who else / which agents are watching
  const [presence, setPresence] = useState<Presence[]>([]);
  useEffect(() => {
    const beat = () => {
      if (document.hidden) return;
      pingPresence(pageId);
      getPresence(pageId).then(setPresence).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 8000);
    return () => clearInterval(t);
  }, [pageId]);
  // "select all → copy" the whole page as Markdown. Blocks are separate textareas, so
  // a second Ctrl/⌘+A (or one with nothing focused) selects the page instead of a block;
  // a copy while page-selected writes Markdown to the clipboard.
  const [pageSelected, setPageSelected] = useState(false);
  useEffect(() => {
    if (!pageSelected) return;
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData(
        "text/plain",
        blocksToMarkdown(page?.title ?? "", blocksRef.current),
      );
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [pageSelected, page?.title]);
  const onPageKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "a" || e.key === "A")) {
      const el = document.activeElement as HTMLTextAreaElement | null;
      const inTextarea = el?.tagName === "TEXTAREA";
      const fullySelected = inTextarea &&
        el!.selectionStart === 0 && el!.selectionEnd === el!.value.length &&
        el!.value.length > 0;
      // first Ctrl+A selects the focused block (native); a second one selects the page
      if (!inTextarea || fullySelected) {
        e.preventDefault();
        el?.blur();
        document.getSelection()?.removeAllRanges();
        setPageSelected(true);
      }
    } else if (e.key !== "Meta" && e.key !== "Control") {
      setPageSelected(false); // any other key drops the whole-page selection
    }
  };
  // live-refresh comments so watcher status (seen/answering) and agent replies appear
  // without a reload; only swap state when the payload actually changed (keeps
  // in-progress edits and avoids re-render churn), and pause when the tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      listComments(pageId).then((next) =>
        setComments((
          prev,
        ) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      ).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);
  const [iconOpen, setIconOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const savingRef = useRef(0); // in-flight updatePage calls
  const blocksRef = useRef<Block[]>([]);

  // live-refresh content written by others (agents via MCP, another tab). Never
  // while the user is mid-edit — focused input/textarea, pending debounce, or
  // in-flight save skips the tick, re-checked once the fetch resolves.
  useEffect(() => {
    const busy = () => {
      if (saveTimer.current !== undefined || savingRef.current > 0) return true;
      const tag = document.activeElement?.tagName;
      return tag === "TEXTAREA" || tag === "INPUT";
    };
    const tick = () => {
      if (document.hidden || busy()) return;
      getPage(pageId).then((p) => {
        if (busy()) return; // an edit started while the fetch was in flight
        if (
          p.content.length &&
          JSON.stringify(p.content) !== JSON.stringify(blocksRef.current)
        ) {
          const { blocks: content, changed } = ensureIds(p.content);
          setBlocks(content);
          blocksRef.current = content;
          if (changed) {
            savingRef.current++;
            updatePage(pageId, { content }).catch(() => {}).finally(() =>
              savingRef.current--
            );
          }
        }
        setPage((
          prev,
        ) => (JSON.stringify(prev) === JSON.stringify(p) ? prev : p));
      }).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);

  const reload = () => getPage(pageId).then(setPage).catch(() => {});
  const reloadComments = () =>
    listComments(pageId).then(setComments).catch(() => {});
  const commentOps: CommentOps = {
    add: (blockId, anchor, body) =>
      createComment({
        page_id: pageId,
        block_id: blockId,
        anchor: anchor.slice(0, 300),
        body,
      }).then(reloadComments),
    update: (id, patch) => updateComment(id, patch).then(reloadComments),
    remove: (id) => deleteComment(id).then(reloadComments),
  };
  const setMode = (m: CommentMode) => {
    if (m === commentMode) return;
    setCommentMode(m);
    setFocusThread(null);
    // carry the open state across so switching doesn't hide what you were reading
    if (m === "panel") {
      if (openThreads.size > 0) setPanelOpen(true);
      putOpenThreads(new Set());
    } else {
      if (panelOpen) {
        putOpenThreads(
          new Set(
            comments.filter((c) => showResolved || !c.resolved).map((c) =>
              c.block_id
            ),
          ),
        );
      }
      setPanelOpen(false);
    }
  };
  const toggleThread = (blockId: string) => {
    const opening = !openThreads.has(blockId);
    setFocusThread(opening ? blockId : null);
    putOpenThreads((prev) => {
      const next = new Set(prev);
      if (opening) next.add(blockId);
      else next.delete(blockId);
      return next;
    });
  };
  const flashBlock = (blockId: string) => {
    document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(blockId);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  };
  useEffect(() => {
    setShowResolved(false);
    setOpenThreads(loadOpenThreads(pageId)); // restore this page's expanded threads
    setFocusThread(null);
    getPage(pageId).then((p) => {
      setPage(p);
      setComments(p.comments ?? []);
      const raw = p.content.length
        ? p.content
        : [{ type: "text", text: "", id: genId() } as Block];
      // durable ids up front so a comment made before the next edit can't orphan
      const { blocks: content, changed } = ensureIds(raw);
      setBlocks(content);
      blocksRef.current = content;
      if (changed) {
        savingRef.current++;
        updatePage(pageId, { content }).catch(() => {}).finally(() =>
          savingRef.current--
        );
      }
    }).catch(() => {});
    return () => {
      // flush a pending debounce so fast page-switches don't lose the last edit
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        updatePage(pageId, { content: blocksRef.current }).catch(() => {});
      }
    };
  }, [pageId]);

  const changeBlocks = (next: Block[]) => {
    setBlocks(next);
    blocksRef.current = next;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      savingRef.current++;
      updatePage(pageId, { content: blocksRef.current }).catch(() => {})
        .finally(() => savingRef.current--);
    }, 800);
  };

  const patch = (p: Parameters<typeof updatePage>[1]) => {
    savingRef.current++;
    return updatePage(pageId, p).then(reload).then(onChanged)
      .finally(() => savingRef.current--);
  };

  const newSubpage = () =>
    createPage({ parent_id: pageId }).then((
      r,
    ) => (onChanged(), onOpenPage(r.id)));
  const newStory = () =>
    createPage({ parent_id: pageId, kind: "story" }).then((
      r,
    ) => (onChanged(), onOpenPage(r.id)));
  const slashInsert = (kind: "subpage" | "database", replaceIdx: number) => {
    // drop the "/…" block the user was typing in, then create the target
    const next = blocks.filter((_, j) => j !== replaceIdx);
    // needs an id like every other block — a comment on an id-less block is stored
    // against "" and orphans for good once ensureIds backfills a real one
    changeBlocks(
      next.length ? next : [{ type: "text", text: "", id: genId() } as Block],
    );
    if (kind === "subpage") newSubpage();
    else {
      createUdb("Untitled").then((r) => attachUdbToPage(r.id, pageId)).then(
        () => {
          reload();
          onChanged();
        },
      );
    }
  };

  const finished = useFinishedCards(
    board.sessions.filter((s) => !statusStyle(s.status).terminal && inSubtree(s, pageId, pagesById(board.pages))),
  );
  if (!page) return <p className="p-6 text-ink-muted">Loading…</p>;
  const client = board.projects.find((c) => c.id === page.client_id);
  const isProject = page.kind === "project";
  const isStory = page.kind === "story";
  // distinct sessions linked anywhere on the page — the Activity chip's subject
  const linkedSessions = new Set((page.links ?? []).map((l) => l.session_id).filter(Boolean)).size;
  // sessions come from the polled board (not the fetch-once getPage) so they stay live.
  // subtree semantics: anything anchored to this page or any page nested under it.
  const byId = pagesById(board.pages);
  const childStoryIds = new Set(
    page.children.filter((c) => c.kind === "story").map((c) => c.id),
  );
  const subtreeSessions = board.sessions.filter((s) => inSubtree(s, pageId, byId));
  // the card whose specs are this page — off the polled board, so it stays live
  const specCard = board.sessions.find((x) => x.specs_page_id === page.id);
  // a story can't hold another one: no "Convert to user story" below a story
  let underStory = false;
  for (let a = page.parent_id ? byId.get(page.parent_id) : undefined; a; a = a.parent_id ? byId.get(a.parent_id) : undefined) {
    if (a.kind === "story") underStory = true;
  }
  // on a story, its cards' spec pages render as the cards themselves
  const specIds = new Set(isStory ? subtreeSessions.map((s) => s.specs_page_id).filter(Boolean) as string[] : []);
  // a card already shown as a chip on one of this page's todos isn't listed again
  const todoIds = new Set(blocks.flatMap((b) => (b.type === "todo" && b.id ? [b.id] : [])));
  const chipped = new Set(
    (page.links ?? []).filter((l) => l.session_id && l.block_id && todoIds.has(l.block_id)).map((l) => l.session_id),
  );
  const sessions = subtreeSessions
    .filter((s) => !chipped.has(s.id))
    .sort((a, b) =>
      (statusStyle(a.status).terminal ? 1 : 0) -
      (statusStyle(b.status).terminal ? 1 : 0)
    );
  const done = sessions.filter((s) => statusStyle(s.status).terminal).length;
  // the header's progress counts every card, chipped or not
  const doneAll = subtreeSessions.filter((s) => statusStyle(s.status).terminal).length;
  // a project's sessions come from several stories — group them under their story
  // instead of one flat list; a story only ever shows its own.
  const sessionsByStory = isProject
    ? page.children
      .filter((c) => c.kind === "story")
      .map((story) => ({
        story,
        list: sessions.filter((s) => storyOf(s, byId)?.id === story.id),
      }))
      .filter((g) => g.list.length > 0)
    : [];
  const ungroupedSessions = isProject
    ? sessions.filter((s) => !childStoryIds.has(storyOf(s, byId)?.id ?? ""))
    : sessions;
  const finishedCards = sessions.filter((s) => !statusStyle(s.status).terminal && finished.has(s.id));
  const { inProgress, looseOpen, storiesInSessions } = groupInProgress({
    sessionsByStory,
    ungroupedSessions,
    finished,
    board,
    cardQuery,
    storyOrder,
    byId,
  });
  const inProgressBlock = isProject && (
    <InProgressBlock
      finishedCards={finishedCards}
      inProgress={inProgress}
      looseOpen={looseOpen}
      cardQuery={cardQuery}
      setCardQuery={setCardQuery}
      storyOrder={storyOrder}
      setStoryOrder={setStoryOrder}
      unfoldedStories={unfoldedStories}
      setUnfoldedStories={setUnfoldedStories}
      onOpenPage={onOpenPage}
      onOpenSession={onOpenSession}
    />
  );
  const childRow = (c: PageChild, hideTag: string | null = null) => (
    <PageRow key={c.id} c={c} hideTag={hideTag} live={liveAgentsAll} onOpen={onOpenPage} />
  );
  const blockIds = new Set(
    blocks.filter(isText).map((b) => b.id).filter(Boolean) as string[],
  );
  const orphans = comments.filter((c) => !blockIds.has(c.block_id));
  const resolvedCount =
    comments.filter((c) => c.resolved && blockIds.has(c.block_id)).length;
  const openCount =
    comments.filter((c) => !c.resolved && blockIds.has(c.block_id)).length;
  const commentedIds = [
    ...new Set(
      comments.filter((c) =>
        blockIds.has(c.block_id) && (showResolved || !c.resolved)
      ).map((c) => c.block_id),
    ),
  ];
  const allOpen = commentedIds.length > 0 &&
    commentedIds.every((id) => openThreads.has(id));
  // panel threads follow block order so the list reads like the page
  const panelThreads = blocks.filter(isText).flatMap((b) => {
    if (!b.id) return [];
    const list = comments.filter((c) =>
      c.block_id === b.id && (showResolved || !c.resolved)
    );
    return list.length ? [{ block: b, list }] : [];
  });

  return (
    <div
      className="flex min-h-0 flex-1"
      onKeyDown={onPageKeyDown}
      onMouseDown={() => setPageSelected(false)}
    >
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-7 ${
            pageSelected
              ? "rounded-lg bg-copper/[0.07] ring-1 ring-copper/25"
              : ""
          }`}
        >
          {isStory && (
            <span className={`-mb-3 ${SECTION_LABEL}`}>
              {markRoleOf(page.content ?? []) === "ticket" ? "TICKET" : "USER STORY"}
            </span>
          )}
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                className={`rounded-md p-1 leading-none transition-colors hover:bg-panel ${
                  isProject ? "text-[30px]" : "text-[22px]"
                }`}
                title="page icon"
                onClick={() => setIconOpen(true)}
              >
                <EntityIcon
                  icon={page.icon}
                  fallback={pageGlyph(
                    page.kind,
                    markRoleOf(page.content ?? []),
                  )}
                  className={page.icon ? "" : "text-ink-muted"}
                  size={isProject ? 32 : 22}
                />
              </button>
              {iconOpen && (
                <IconPicker
                  current={page.icon}
                  onPick={(icon) => patch({ icon })}
                  onClose={() => setIconOpen(false)}
                />
              )}
            </div>
            <input
              key={page.id + page.title}
              className="w-full border-none bg-transparent text-[22px] font-semibold text-ink outline-none placeholder:text-ink-muted/40"
              defaultValue={page.title}
              placeholder="Untitled"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== page.title) patch({ title: v });
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            {linkedSessions > 0 && <PageActivityChip pageId={page.id} sessions={linkedSessions} />}
            {specCard && (
              <button
                type="button"
                title="Open the session this page is the specs of"
                className="shrink-0 rounded-md border border-copper/40 bg-copper/[0.06] px-2 py-0.5 text-[11.5px] text-copper transition-colors hover:border-copper/60 hover:bg-copper/10"
                onClick={() => onOpenSession(specCard.id, true)}
              >
                ▦ Open session ↗
              </button>
            )}
            {isProject && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  title="project color"
                  className="h-5 w-5 rounded-md border border-chipline"
                  style={{ background: page.color ?? "var(--color-chipline)" }}
                  onClick={() => setColorOpen((o) => !o)}
                />
                {colorOpen && (
                  <Popover
                    onClose={() => setColorOpen(false)}
                    className="right-0 left-auto flex w-auto gap-1.5 p-2"
                  >
                    {PROJECT_COLORS.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={`h-5 w-5 rounded-md ${
                          page.color === c
                            ? "ring-2 ring-ink ring-offset-1 ring-offset-panel-modal"
                            : ""
                        }`}
                        style={{ background: c }}
                        onClick={() => {
                          patch({ color: c });
                          setColorOpen(false);
                        }}
                      />
                    ))}
                  </Popover>
                )}
              </div>
            )}
            <div className="flex shrink-0 items-center gap-1.5 pl-1">
              {(() => {
                // agents with comments on this page but no live watcher heartbeat;
                // watcher ids are watcher:<agent> or watcher:<agent>:<page> (scoped),
                // and presence already filters scoped ones to this page
                const watching = new Set(
                  presence.filter((p) => p.kind === "watcher").map((p) =>
                    p.id.split(":")[1]
                  ),
                );
                const startable = new Map<string, PageComment>();
                for (const c of comments) {
                  const id = c.author.trim().toLowerCase();
                  if (isAgent(c) && id && !watching.has(id)) {
                    startable.set(id, c);
                  }
                }
                return startable.size > 0 && (
                  <div className="flex items-center">
                    {[...startable].map(([id, c]) => (
                      <StartWatcherButton
                        key={id}
                        agent={id}
                        name={c.author}
                        avatar={c.author_avatar}
                        pageId={pageId}
                      />
                    ))}
                  </div>
                );
              })()}
              <PresenceBar people={presence} />
            </div>
          </div>

          <PageHeaderMenu
            page={page}
            patch={patch}
            canConvert={!isProject && !isStory && !specCard}
            underStory={underStory}
            headerMenu={headerMenu}
            setHeaderMenu={setHeaderMenu}
            idCopied={idCopied}
            setIdCopied={setIdCopied}
            onShowMarkdown={() => setMdOpen(true)}
            setPage={setPage}
            onChanged={onChanged}
            onOpenSession={onOpenSession}
          />

          {mdOpen && (
            <MarkdownPanel
              markdown={blocksToMarkdown(page.title, blocksRef.current)}
              copied={mdCopied}
              setCopied={setMdCopied}
              onClose={() => setMdOpen(false)}
            />
          )}

          {isStory && (
            <div className="flex items-center gap-3">
              <div className="w-[120px]">
                {(() => {
                  const def = PAGE_STATUSES.find((s) => s.value === page.status);
                  return (
                    <Select
                      value={page.status}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium outline-none"
                      triggerStyle={def
                        ? { background: `color-mix(in srgb, ${def.color} 13%, transparent)`, color: def.color }
                        : undefined}
                      options={PAGE_STATUSES.map((s) => ({ value: s.value, label: s.label, dot: s.color }))}
                      onChange={(status) => patch({ status })}
                    />
                  );
                })()}
              </div>
              {client && (
                <ClientChip
                  name={client.name}
                  color={client.color}
                  onClick={() => onOpenClient(client.id)}
                />
              )}
              {subtreeSessions.length > 0 && (
                <>
                  <div className="h-[5px] w-[140px] overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-copper"
                      style={{ width: `${(doneAll / subtreeSessions.length) * 100}%` }}
                    />
                  </div>
                  <span className="text-[11.5px] font-medium text-ink-muted">
                    {doneAll} / {subtreeSessions.length} done
                  </span>
                </>
              )}
            </div>
          )}

          {isStory && (
            <textarea
              key={page.id + page.brief}
              rows={2}
              className="resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink-soft outline-none transition-colors placeholder:italic placeholder:text-ink-muted/50 hover:bg-well focus:border-chipline focus:bg-well"
              defaultValue={page.brief}
              placeholder="add the brief — what are we trying to achieve? (click to edit)"
              onBlur={(e) => {
                if (e.target.value !== page.brief) {
                  patch({ brief: e.target.value });
                }
              }}
            />
          )}

          {/* Below the brief, because the brief becomes the ticket's
              objective: the offer sits next to the text it will send. */}
          {FRONTEND_PLUGINS.map((p) => p.PageHeader && <p.PageHeader key={p.id} page={page} onDone={() => reload()} />)}

          {/* a story's cards show as agents on its sub-pages and chips on todos */}
          {!isStory && !isProject && sessions.length > 0 && (
            <SessionsPanel
              atTop
              sessions={sessions}
              done={done}
              sessionFilter={sessionFilter}
              setSessionFilter={setSessionFilter}
              finishedCards={finishedCards}
              finished={finished}
              sessionsByStory={sessionsByStory}
              ungroupedSessions={ungroupedSessions}
              onOpenSession={onOpenSession}
            />
          )}
          {isStory && subtreeSessions.length > 0 && (
            <CardsSection
              sessions={subtreeSessions}
              pageChildren={page.children}
              showDone={showDoneCards}
              onToggleDone={() => setShowDoneCards((v) => !v)}
              live={liveAgentsAll}
              recent={recentAgents}
              onOpenSession={onOpenSession}
            />
          )}

          {(openCount > 0 || resolvedCount > 0) && (
            <div className="-mb-2 flex items-center gap-3 self-start">
              {commentMode === "inline"
                ? (
                  <button
                    type="button"
                    className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                    onClick={() => {
                      setFocusThread(null);
                      putOpenThreads(
                        allOpen ? new Set() : new Set(commentedIds),
                      );
                    }}
                  >
                    {allOpen ? "Close" : "Open"} all {openCount}{" "}
                    comment{openCount > 1 ? "s" : ""}
                  </button>
                )
                : (
                  <button
                    type="button"
                    className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                    onClick={() => setPanelOpen((v) => !v)}
                  >
                    {panelOpen ? "Hide" : "Show"} comments panel ({openCount})
                  </button>
                )}
              {resolvedCount > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                  onClick={() => {
                    const next = !showResolved;
                    setShowResolved(next);
                    // inline mode: reveal AND expand the threads holding resolved notes
                    if (next && commentMode === "inline") {
                      setFocusThread(null);
                      putOpenThreads((prev) => {
                        const n = new Set(prev);
                        for (const c of comments) {
                          if (c.resolved && blockIds.has(c.block_id)) {
                            n.add(c.block_id);
                          }
                        }
                        return n;
                      });
                    }
                  }}
                >
                  {showResolved ? "Hide" : "Show"} {resolvedCount}{" "}
                  resolved comment{resolvedCount > 1 ? "s" : ""}
                </button>
              )}
              <div className="flex overflow-hidden rounded-md border border-line-soft text-[10.5px]">
                {(["inline", "panel"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`px-2 py-0.5 capitalize transition-colors ${
                      commentMode === m
                        ? "bg-panel text-ink-soft"
                        : "text-ink-muted/60 hover:text-ink-soft"
                    }`}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          <BlockEditor
            blocks={blocks}
            onChange={changeBlocks}
            links={page?.links ?? []}
            onOpenSession={onOpenSession}
            onLinkItem={(blockId, item) => setLinkPick({ blockId, item })}
            onSlashInsert={slashInsert}
            onOpenReport={onOpenReport}
            comments={comments}
            commentOps={commentOps}
            showResolved={showResolved}
            mode={commentMode}
            openThreads={openThreads}
            focusThread={focusThread}
            flash={flash ?? focused}
            meId={meId}
            onToggleThread={toggleThread}
          />

          {linkPick && (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]"
              onClick={() => setLinkPick(null)}
            >
              <div
                className="w-[440px] rounded-xl border border-line bg-panel-modal p-3 shadow-2xl shadow-black/50"
                onClick={(e) => e.stopPropagation()}
              >
                <div className={`mb-1.5 ${SECTION_LABEL}`}>
                  LINK TO SESSION
                </div>
                <div
                  className="mb-2 truncate rounded-md bg-panel px-2 py-1 text-[11.5px] text-ink-muted"
                  title={linkPick.item}
                >
                  {linkPick.item}
                </div>
                <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                  {[...board.sessions]
                    .sort((a, b) =>
                      (statusStyle(a.status).terminal ? 1 : 0) -
                      (statusStyle(b.status).terminal ? 1 : 0)
                    )
                    .map((sn) => (
                      <button
                        key={sn.id}
                        type="button"
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-panel"
                        onClick={() => {
                          addSessionLink(sn.id, {
                            page_id: pageId,
                            block_id: linkPick.blockId,
                            anchor: linkPick.item,
                          }).then(() => {
                            setLinkPick(null);
                            reload();
                          });
                        }}
                      >
                        <span
                          className="h-[7px] w-[7px] shrink-0 rounded-full"
                          style={{ background: statusStyle(sn.status).color }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {sn.title}
                        </span>
                        {sn.branch && (
                          <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                            {sn.branch}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}

          {orphans.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-panel/30 p-3">
              <span className={`${SECTION_LABEL}`}>
                COMMENTS ON REMOVED TEXT
              </span>
              {orphans.map((c) => (
                <div key={c.id} className="flex flex-col gap-1">
                  {c.anchor && (
                    <span className="truncate border-l-2 border-line pl-2 text-[11px] italic text-ink-muted/70">
                      “{c.anchor}”
                    </span>
                  )}
                  <CommentItem
                    c={c}
                    canEdit={Boolean(meId) && c.author_id === meId}
                    onUpdate={(patch) =>
                      commentOps.update(c.id, patch)}
                    onDelete={() =>
                      commentOps.remove(c.id)}
                  />
                </div>
              ))}
            </div>
          )}

          {page.databases.map((d) => (
            // breakout: attached databases use the pane's width (100cqw minus the
            // px-8 gutters), not the 820px text column
            <div
              key={d.id}
              className="relative left-1/2 flex w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2 flex-col gap-1"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                <EntityIcon
                  icon={d.icon}
                  fallback="⌗"
                  className="text-ink-muted"
                />
                {d.name}
              </div>
              <DatabaseView dbId={d.id} epoch={0} udbs={udbs} />
            </div>
          ))}

          <div className="flex flex-col gap-0.5">
            {isStory && page.children.some((c) => !specIds.has(c.id)) && (
              <span className={`mb-1 ${SECTION_LABEL}`}>DOCUMENTS</span>
            )}
            {isProject
              ? <ProjectChildren pages={page.children} shown={storiesInSessions} row={childRow} top={inProgressBlock} />
              : (() => {
                const docs = page.children.filter((c) => !specIds.has(c.id));
                const archived = docs.filter((c) => c.status === "archived");
                return (
                  <>
                    {docs.filter((c) => c.status !== "archived").map((c) => childRow(c))}
                    {showArchivedDocs && archived.map((c) => childRow(c))}
                    {archived.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowArchivedDocs((v) => !v)}
                        className="self-start rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                      >
                        {showArchivedDocs ? "▾ Hide" : "▸"} {archived.length} archived
                      </button>
                    )}
                  </>
                );
              })()}
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
              onClick={isProject ? newStory : newSubpage}
            >
              <span className="text-[11px]">＋</span>{" "}
              {isProject ? "New story" : "New sub-page"}
            </button>
          </div>

        </div>
      </div>
      {commentMode === "panel" && panelOpen && (
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-sidebar">
          <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
            <span className="text-[12px] font-semibold text-ink">Comments</span>
            <span className="text-[10.5px] text-ink-muted">
              {openCount} open
            </span>
            <span className="flex-1" />
            {resolvedCount > 0 && (
              <button
                type="button"
                className="text-[10.5px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                onClick={() => setShowResolved((v) => !v)}
              >
                {showResolved ? "hide" : "show"} resolved
              </button>
            )}
            <button
              type="button"
              title="close"
              className="text-[11px] text-ink-muted transition-colors hover:text-ink-soft"
              onClick={() => setPanelOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {panelThreads.map(({ block, list }) => (
              <div key={block.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  title="jump to text"
                  className="truncate border-l-2 border-chipline pl-2 text-left text-[11px] italic text-ink-muted/70 transition-colors hover:text-ink-soft"
                  onClick={() =>
                    flashBlock(block.id as string)}
                >
                  “{block.text || "…"}”
                </button>
                {list.map((c) => {
                  const q = anchorQuoteOf(c, block.text);
                  return (
                    <div key={c.id} className="flex flex-col gap-1">
                      {q && <RowNote label={q.label} text={q.text} />}
                      <CommentItem
                        c={c}
                        canEdit={Boolean(meId) && c.author_id === meId}
                        answered={answeredIn(c, list)}
                        onUpdate={(patch) =>
                          commentOps.update(c.id, patch)}
                        onDelete={() =>
                          commentOps.remove(c.id)}
                      />
                    </div>
                  );
                })}
                <AddNote
                  onAdd={(body) =>
                    commentOps.add(block.id as string, block.text, body)}
                />
              </div>
            ))}
            {panelThreads.length === 0 && (
              <span className="px-1 text-[11px] text-ink-muted/60">
                No comments
              </span>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

// Header-level delete used by App (kept here so the confirm copy lives with the page code).
export async function confirmDeletePage(
  page: { id: string; title: string },
): Promise<boolean> {
  const ok = await appConfirm(
    `Delete "${
      page.title || "Untitled"
    }" and everything inside it (sub-pages and attached databases)?`,
  );
  if (ok) await deletePage(page.id);
  return ok;
}
