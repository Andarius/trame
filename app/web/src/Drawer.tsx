import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FRONTEND_PLUGINS } from "./plugins";
import {
  addLog,
  type BoardData,
  deleteSession,
  deleteSessionLink,
  getEvents,
  getPageEvents,
  getSessionLinks,
  probeResume,
  type ResumeInfo,
  type ResumeMode,
  resumeSession,
  saveSession,
  type Session,
  type SessionEvent,
  type SessionLink,
  type Status,
  getPage,
  updatePage,
} from "./api";
import { appConfirm, clientColor, EntityIcon, ExpandIcon, FieldRow, pageOptions, Popover, Select, TagChips, timeAgo } from "./ui";
import { AgentIcon, AgentsSummary, EventMeta, PresencePill, useAgents } from "./agents";
import { summarizeAgents } from "./agent-summary";
import { PrChip, RepoLink } from "./md";
import { SpecsEditor } from "./SpecsEditor";
import { TagEditor } from "./TagEditor";

// How the Resume button places the session; the last pick is the default, persisted.
const RESUME_MODES: { mode: ResumeMode; label: string; hint: string }[] = [
  { mode: "window", label: "New window", hint: "opens a fresh terminal window" },
  { mode: "tab", label: "New tab", hint: "adds a tab to your open terminal" },
  { mode: "existing", label: "Existing session", hint: "types into your focused konsole" },
];
const RESUME_DONE: Record<ResumeMode, string> = {
  window: "terminal opened",
  tab: "tab opened",
  existing: "sent to terminal",
};

const sectionLbl = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/70";
const rowLbl = "shrink-0 pt-[5px] text-[11px] text-ink-muted";

const rowVal =
  "w-full truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-ink outline-none transition-colors hover:bg-panel focus:border-chipline focus:bg-panel";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-x-2">
      <span className={rowLbl}>{label}</span>
      {children}
    </div>
  );
}

export const TOPBAR_SLOT = "topbar-actions";
const TOP_BTN =
  "shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft";

export function Drawer(
  { session, board, onClose, onSaved, defaultExpanded, onExpandedChange, onOpenPage, embedded = false }: {
    session: Session;
    board: BoardData;
    onClose: () => void;
    onSaved: () => void;
    defaultExpanded?: boolean;
    // the card view: full layout inside the main area (sidebar + top bar stay), no overlay
    embedded?: boolean;
    onExpandedChange?: (v: boolean) => void; // App mirrors it into the URL
    onOpenPage?: (id: string) => void; // navigate to a linked page
  },
) {
  const { live, recent } = useAgents();
  const [title, setTitle] = useState(session.title);
  // embedded: session actions live in App's top bar, next to "Sync now"
  const [topSlot, setTopSlot] = useState<Element | null>(null);
  useEffect(() => setTopSlot(embedded ? document.getElementById(TOPBAR_SLOT) : null), [embedded]);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const flashCopied = (msg: string) => {
    setCopied(msg);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2500);
  };
  const [status, setStatus] = useState<Status>(session.status);
  const [client, setClient] = useState(board.projects.find((c) => c.id === session.client_id)?.name ?? "");
  const [pageId, setPageId] = useState(session.page_id ?? "");
  const [tags, setTags] = useState(session.tags ?? []);
  useEffect(() => setTags(session.tags ?? []), [session.tags]);
  const [branch, setBranch] = useState(session.branch ?? "");
  const [nextStep, setNextStep] = useState(session.next_step ?? "");
  const [prUrl, setPrUrl] = useState(session.pr_url ?? "");
  const [prNew, setPrNew] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  // JS auto-grow: field-sizing:content isn't supported in the desktop WebKitGTK webview,
  // so long next-steps would clip. Size the textarea to its content by hand.
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  // a double-click while this session's drawer is already open still expands it
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded]);
  const nsRef = useRef<HTMLTextAreaElement>(null);
  const [nsEditing, setNsEditing] = useState(false);
  const growNs = () => {
    const el = nsRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const prLinks = prUrl.split("\n").map((s) => s.trim()).filter(Boolean);
  // the card's journal plus, through its spec page, the entries of sessions working on its todos
  const [events, setEvents] = useState<(SessionEvent & { session_id?: string; session_title?: string | null })[]>([]);
  const loadJournal = () =>
    Promise.all([
      getEvents(session.id),
      session.specs_page_id ? getPageEvents(session.specs_page_id).catch(() => []) : Promise.resolve([]),
    ]).then(([own, linked]) => {
      // guard: a stale backend may answer an error object instead of an array
      if (!Array.isArray(own)) return;
      const others = (Array.isArray(linked) ? linked : []).filter((e) => e.session_id !== session.id);
      setEvents([...own, ...others].sort((a, b) => b.at.localeCompare(a.at)));
    }).catch(() => {});
  // page-item links ("this session works on that TODO line")
  const [links, setLinks] = useState<SessionLink[]>([]);
  useEffect(() => {
    getSessionLinks(session.id).then((l) => Array.isArray(l) && setLinks(l))
      .catch(() => {});
  }, [session.id]);
  const [log, setLog] = useState("");
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null);
  const [resumeMenu, setResumeMenu] = useState(false);
  const [resumeMode, setResumeMode] = useState<ResumeMode>(
    () => (localStorage.getItem("trame:resumeMode") as ResumeMode | null) ?? "window",
  );
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // probe on open so the button shows whether this session is resumable HERE vs on another device
  useEffect(() => {
    setResumeInfo(null);
    if (!session.repo_path) return;
    probeResume(session.id).then(setResumeInfo).catch(() => {});
  }, [session.id, session.repo_path]);

  // size the next-step textarea to its content when it enters edit mode
  useEffect(() => {
    if (nsEditing) growNs();
  }, [nsEditing]);

  const doResume = async (mode: ResumeMode = resumeMode) => {
    setResumeMenu(false);
    setResumeMode(mode);
    localStorage.setItem("trame:resumeMode", mode);
    let msg: string;
    try {
      const r = await resumeSession(session.id, mode);
      if (r.launched) {
        msg = RESUME_DONE[mode];
      } else {
        // couldn't launch → copy the command as an escape hatch, then explain why
        try {
          await navigator.clipboard?.writeText(r.cmd);
        } catch { /* clipboard blocked — still show why below */ }
        msg = r.reason === "api-disabled"
          ? "enable konsole D-Bus — copied"
          : r.local === false
          ? (r.homeNode ? `on ${r.homeNode} — copied` : "no transcript here — copied")
          : "command copied";
      }
    } catch {
      msg = "failed";
    }
    setResumeMsg(msg);
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setResumeMsg(null), 2500);
  };

  useEffect(() => {
    loadJournal();
    return () => {
      clearTimeout(flashTimer.current);
      clearTimeout(resumeTimer.current);
    };
  }, [session.id]);

  const commit = (over: Record<string, unknown> = {}) =>
    saveSession({
      id: session.id,
      title,
      status,
      client: client || undefined,
      page_id: pageId || null,
      repo_path: session.repo_path,
      branch: branch || undefined,
      next_step: nextStep || undefined,
      pr_url: prUrl || undefined,
      summary: session.summary,
      no_event: true,
      ...over,
    }).then(() => {
      onSaved();
      setFlash(true);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 1500);
    });

  // blur-commit for text fields: only save when the value actually changed
  const commitIf = (changed: boolean) => changed && commit();

  const submitLog = () => {
    if (!log.trim()) return;
    addLog(session.id, log.trim()).then(() => {
      setLog("");
      loadJournal();
      onSaved();
    });
  };

  const remove = async () => {
    if (await appConfirm(`Delete session "${session.title}"?`)) {
      deleteSession(session.id).then(onClose).then(onSaved);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit().then(onClose);
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  });

  // shared pieces — composed differently by the side-panel and expanded (ticket) layouts
  const headerBar = (
    <div
      className="flex items-center gap-2 px-4 pb-1 pt-3.5"
      onDoubleClick={embedded ? undefined : (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        document.getSelection()?.removeAllRanges();
        setExpanded((v) => !v);
      }}
    >
      <span className={sectionLbl}>SESSION</span>
      <span className="flex-1" />
      {session.repo_path && (
        <span className="truncate font-mono text-[10px] text-ink-muted/70" title={session.repo_path}>
          {session.repo_path.split("/").slice(-2).join("/")}
        </span>
      )}
      {!embedded && (
        <button type="button"
          className="flex items-center rounded-md px-1.5 py-1 text-ink-muted transition-colors hover:bg-panel hover:text-ink"
          title={expanded ? "collapse to side panel" : "open the session"}
          onClick={() => setExpanded((v) => !v)}
        >
          <ExpandIcon open={expanded} />
        </button>
      )}
      <button type="button"
        className="rounded-md px-1.5 py-0.5 text-[13px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
        title="close (esc)"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );

  // a session has no icon of its own: its spec page's stands in
  const specIcon = board.pages.find((p) => p.id === session.specs_page_id)?.icon ?? null;
  // agents on this card: its own presence, or anyone working on its spec page
  const cardAgents = live.filter(({ a }) =>
    a.session_id === session.id || (!!session.specs_page_id && a.page_id === session.specs_page_id)
  );
  const titleInput = (
    <div className="flex items-start gap-1.5">
      {specIcon && <EntityIcon icon={specIcon} className="mt-1 text-[17px]" />}
      <textarea
        className="field-sizing-content resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold leading-snug text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
        rows={2}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commitIf(title !== session.title)}
      />
    </div>
  );
  // every named session that wrote to this card's worklog, plus the ones live or recently seen
  const workedBy = [...new Set([
    ...cardAgents.map(({ a }) => a.name).filter(Boolean),
    ...recent.filter((a) =>
      a.session_id === session.id || (!!session.specs_page_id && a.page_id === session.specs_page_id)
    ).map((a) => a.name).filter(Boolean),
    ...events.map((e) => e.agent_name).filter(Boolean),
  ] as string[])];
  // design 4: per-agent model, tokens, time and state, from the journal plus live reports
  const agentSummaries = summarizeAgents(events, [
    ...cardAgents.map(({ a, state }) => ({ name: a.name, harness: a.harness, model: a.model, tokens: a.tokens, state })),
    ...recent.filter((a) =>
      (a.session_id === session.id || (!!session.specs_page_id && a.page_id === session.specs_page_id)) &&
      !cardAgents.some((l) => l.a.session_id === a.session_id)
    ).map((a) => ({ name: a.name, harness: a.harness, model: a.model, tokens: a.tokens, state: null })),
  ]);
  const agentChips = cardAgents.length > 0 && (
    <div className="flex flex-wrap gap-1.5">
      {cardAgents.map(({ a, state }) => (
        <span
          key={a.session_id}
          title={`${a.session_title} — ${state === "working" ? "working" : "needs you"}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-chipline/60 px-1.5 py-0.5 text-[11px] text-ink-muted"
        >
          <AgentIcon a={a} />
          {a.name ?? a.harness}
          <span className={`h-1.5 w-1.5 rounded-full ${state === "working" ? "bg-live" : "bg-wait"}`} />
        </span>
      ))}
    </div>
  );
  const titleField = (
    <div className="flex flex-col gap-1">
      {titleInput}
      {workedBy.length > 0 && (
        <div className="px-1 text-[11.5px] text-ink-faint">
          worked on by <span className="text-ink-muted">{workedBy.join(" · ")}</span>
        </div>
      )}
      {agentChips && <div className="px-1">{agentChips}</div>}
    </div>
  );

  const statusDef = board.statuses.find((d) => d.key === status);
  // named for a11y: the side panel shows this control without a visible caption
  const statusSelect = (
    <div role="group" aria-label="Status" className="w-fit min-w-[130px]">
      <Select
        value={status}
        className="rounded-md px-2.5 py-1 text-xs font-medium outline-none"
        triggerStyle={statusDef
          ? {
            background: `color-mix(in srgb, ${statusDef.color} 13%, transparent)`,
            color: statusDef.color,
          }
          : undefined}
        options={board.statuses.map((d) => ({ value: d.key, label: d.label, dot: d.color }))}
        onChange={(v) => {
          setStatus(v as Status);
          commit({ status: v });
        }}
      />
    </div>
  );

  const resumeBlock = session.repo_path && (() => {
    const foreign = resumeInfo?.local === false; // transcript lives on another device
    // Foreign transcript: single button that copies the command (launch modes don't apply).
    if (foreign) {
      return (
        <button type="button"
          className="flex items-center justify-center gap-2 rounded-lg border border-line bg-transparent py-2 text-[12px] font-medium text-ink-muted transition-colors hover:border-chipline hover:text-ink-soft"
          title={`This session's transcript lives on ${
            resumeInfo?.homeNode ?? "another device"
          } — resume it there. Click to copy the command.`}
          onClick={() => doResume()}
        >
          <span className="text-[13px]">⧉</span>
          {resumeMsg ??
            (resumeInfo?.homeNode ? `On ${resumeInfo.homeNode}` : "No transcript on this device")}
        </button>
      );
    }
    const active = RESUME_MODES.find((m) => m.mode === resumeMode) ?? RESUME_MODES[0];
    const agentLabel = resumeInfo?.agent === "codex" ? "Codex" : "Claude";
    const btn = "border-copper/40 bg-copper/[0.06] text-copper transition-colors hover:border-copper/60 hover:bg-copper/10";
    return (
      <div className="relative flex">
        <button type="button"
          className={`flex flex-1 items-center justify-center gap-2 rounded-l-lg border border-r-0 py-2 text-[12px] font-medium ${btn}`}
          title={`Resume in ${session.repo_path} — ${active.hint}`}
          onClick={() => doResume()}
        >
          <span className="text-[13px]">⏵</span>
          {resumeMsg ?? `Resume ${agentLabel} · ${active.label}`}
        </button>
        <button type="button"
          className={`flex items-center rounded-r-lg border px-2 text-[10px] ${btn}`}
          title="choose how to open"
          onClick={() => setResumeMenu((v) => !v)}
        >
          ▾
        </button>
        {resumeMenu && (
          <Popover onClose={() => setResumeMenu(false)} className="left-auto right-0 min-w-[220px]">
            {RESUME_MODES.map((m) => (
              <button type="button"
                key={m.mode}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel"
                onClick={() => doResume(m.mode)}
              >
                <span className="flex-1">
                  <span className="block text-xs text-ink-soft">{m.label}</span>
                  <span className="block text-[10px] text-ink-muted/70">{m.hint}</span>
                </span>
                {m.mode === resumeMode && <span className="pt-0.5 text-[10px] text-copper">✓</span>}
              </button>
            ))}
          </Popover>
        )}
      </div>
    );
  })();

  const projectSelect = (
    <Select
      value={client}
      className={rowVal}
      options={[
        { value: "", label: "none" },
        ...board.projects.map((c) => ({ value: c.name, label: c.name, dot: clientColor(c.name, c.color), icon: c.icon })),
      ]}
      onChange={(v) => {
        setClient(v);
        commit({ client: v || undefined });
      }}
    />
  );
  const storyTags = board.stories.find((x) => x.id === pageId)?.tags;
  // the hidden spec page's tags are the card's too; the first edit moves them onto the card
  const [specTags, setSpecTags] = useState<string[]>([]);
  // the spec page's content, for plugins' card fields (a ticket ref stamped on it, …)
  const [specContent, setSpecContent] = useState<unknown[]>([]);
  useEffect(() => {
    if (!session.specs_page_id) {
      setSpecContent([]);
      return setSpecTags([]);
    }
    getPage(session.specs_page_id).then((p) => {
      setSpecTags(p.tags ?? []);
      setSpecContent(p.content ?? []);
    }).catch(() => {});
  }, [session.specs_page_id]);
  const sessionTags = Array.isArray(session.tags) ? (
    <div role="group" aria-label="Session tags" className="min-w-0 py-1">
      <TagEditor tags={[...new Set([...tags, ...specTags])]} onChange={(next) => {
        setTags(next);
        commit({ tags: next });
        if (specTags.length && session.specs_page_id) {
          updatePage(session.specs_page_id, { tags: [] }).then(() => setSpecTags([])).catch(() => {});
        }
      }} />
    </div>
  ) : null;
  const storySelect = (
    <Select
      value={pageId}
      className={rowVal}
      options={[
        { value: "", label: "none" },
        // keep the currently attached story listed even when archived —
        // Select falls back to the placeholder if its value has no option
        ...pageOptions(
          board.stories.filter((s) => s.status !== "archived" || s.id === pageId),
          board.pages ?? [],
        ),
      ]}
      onChange={(v) => {
        setPageId(v);
        commit({ page_id: v || null });
      }}
    />
  );
  // the card view's story chooser: a content-sized pill like status and project
  const storyPill = (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="w-fit min-w-[130px] max-w-full">
        <Select
          value={pageId}
          className="rounded-md px-2.5 py-1 text-xs font-medium outline-none"
          triggerStyle={{ background: "var(--color-card)" }}
          options={[
            { value: "", label: "none" },
            ...pageOptions(
              board.stories.filter((s) => s.status !== "archived" || s.id === pageId),
              board.pages ?? [],
            ),
          ]}
          onChange={(v) => {
            setPageId(v);
            commit({ page_id: v || null });
          }}
        />
      </div>
      <div className="shrink-0">
        <TagChips keys={storyTags} />
      </div>
    </div>
  );
  const storyRow = (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {/* min-w-0 so a long story name truncates instead of shoving the tags out */}
      <div className="min-w-0 flex-1">{storySelect}</div>
      <div className="shrink-0">
        <TagChips keys={storyTags} />
      </div>
    </div>
  );
  const branchInput = (
    <input
      className={`${rowVal} font-mono text-[11px]`}
      value={branch}
      onChange={(e) => setBranch(e.target.value)}
      onBlur={() => commitIf(branch !== (session.branch ?? ""))}
      placeholder="none"
    />
  );
  // past 2 PRs, collapse to the first one + a "+N more" toggle
  const prCollapsed = prLinks.length > 2 && !prOpen;
  const prField = (
    <div className="flex min-w-0 flex-col gap-1">
      {(prCollapsed ? prLinks.slice(0, 1) : prLinks).map((url) => (
        <div key={url} className="group flex min-w-0 items-center gap-1">
          <PrChip url={url} />
          <button type="button"
            className="shrink-0 text-[11.5px] text-ink-muted opacity-0 transition-opacity hover:text-blocked group-hover:opacity-100"
            title="remove"
            onClick={() => {
              const next = prLinks.filter((u) => u !== url).join("\n");
              setPrUrl(next);
              commit({ pr_url: next || undefined });
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {prLinks.length > 2 && (
        <button type="button"
          className="w-fit text-[11.5px] text-ink-muted hover:text-ink"
          onClick={() => setPrOpen(!prOpen)}
        >
          {prCollapsed ? `+${prLinks.length - 1} more ▾` : "show less ▴"}
        </button>
      )}
      <input
        className={rowVal}
        value={prNew}
        onChange={(e) => setPrNew(e.target.value)}
        placeholder={prLinks.length ? "add another PR / MR…" : "https://…"}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const url = prNew.trim();
          if (!/^https?:\/\//.test(url)) return;
          const next = [...prLinks, url].join("\n");
          setPrUrl(next);
          setPrNew("");
          commit({ pr_url: next });
        }}
      />
    </div>
  );

  const nextBanner = (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
        nextStep ? "border-copper/30 bg-copper/[0.07]" : "border-dashed border-chipline/70"
      }`}
      style={nextStep ? { borderLeft: "3px solid var(--color-copper)" } : undefined}
    >
      <span
        className={`shrink-0 pt-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${
          nextStep ? "text-copper" : "text-ink-muted"
        }`}
      >
        ▶ Next
      </span>
      {nsEditing
        ? (
          <textarea
            ref={nsRef}
            autoFocus
            className="w-full resize-none overflow-hidden bg-transparent font-mono text-[12.5px] leading-snug text-ink outline-none placeholder:font-sans placeholder:text-ink-muted/70"
            rows={1}
            value={nextStep}
            onChange={(e) => {
              setNextStep(e.target.value);
              growNs();
            }}
            onBlur={() => {
              commitIf(nextStep !== (session.next_step ?? ""));
              setNsEditing(false);
            }}
            placeholder="what's the next move on resume?"
          />
        )
        : (
          <div
            className="w-full cursor-text whitespace-pre-wrap font-mono text-[12.5px] leading-snug text-ink"
            title="click to edit"
            onClick={() => setNsEditing(true)}
          >
            {nextStep || <span className="font-sans text-ink-muted/70">what's the next move on resume?</span>}
          </div>
        )}
    </div>
  );

  const activityInput = (
    <input
      className="rounded-lg border border-chipline/70 bg-panel px-2.5 py-[7px] text-xs text-ink outline-none transition-colors placeholder:text-ink-muted/60 focus:border-copper/50"
      value={log}
      onChange={(e) => setLog(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && submitLog()}
      placeholder="Log what happened… ↵"
    />
  );

  // dotRing matches the pane background so the timeline dots sit flush on it
  const renderFeed = (dotRing: string) => (
    <div className={`ml-[3px] flex flex-col gap-3.5 pl-3.5 pt-1 ${events.length ? "border-l border-line" : ""}`}>
      {events.map((e) => (
        <div key={e.id} className="relative">
          <span className={`absolute -left-[18px] top-[4px] h-[7px] w-[7px] rounded-full border-2 bg-chipline ${dotRing}`} />
          {e.session_id && e.session_id !== session.id && e.session_title && (
            <div className="mb-0.5 truncate text-[10.5px] font-medium text-ink-muted">{e.session_title}</div>
          )}
          {e.kind === "presence"
            ? <PresencePill e={e} when={timeAgo(e.at)} />
            : (
              <>
                {e.summary && (
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{e.summary}</p>
                )}
                {/* the entry's own agent wins; older track/import rows predate the
                    column and fall back to the session's agent. Manual logs stay bare. */}
                <EventMeta e={e} agent={e.agent ?? (e.kind !== "log" ? session.agent : null)} when={timeAgo(e.at)} />
              </>
            )}
        </div>
      ))}
      {events.length === 0 && <span className="py-1 text-[11px] text-ink-muted/60">No entries yet</span>}
    </div>
  );

  // a todo on the card's own spec page already shows under SPECS
  const outside = links.filter((l) => l.page_id !== session.specs_page_id);
  const linkedRow = outside.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-ink-muted">Linked</span>
      <div className="flex flex-wrap gap-1.5">
        {outside.map((l) => (
          <span
            key={l.id}
            className="group flex max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px]"
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 text-left text-ink-soft transition-colors hover:text-copper"
              title={`${l.page_title ?? "page"}${l.anchor ? ` — ${l.anchor}` : ""}`}
              onClick={() => {
                if (l.page_id) {
                  onOpenPage?.(l.page_id);
                  onClose();
                }
              }}
            >
              <span className="text-[10px] text-ink-muted">▤</span>
              <span className="truncate">{(l.anchor || l.page_title || "").replace(/\*\*|`/g, "")}</span>
            </button>
            <button
              type="button"
              title="unlink"
              className="shrink-0 text-[11px] text-ink-muted opacity-0 transition-opacity hover:text-blocked group-hover:opacity-100"
              onClick={() =>
                deleteSessionLink(l.id).then(() =>
                  getSessionLinks(session.id).then((x) => Array.isArray(x) && setLinks(x))
                )}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );

  const footerBar = (
    <div className="sticky bottom-0 mt-auto flex items-center gap-2 border-t border-line bg-sidebar px-4 py-2.5">
      <button type="button" className="text-[11px] text-ink-muted transition-colors hover:text-blocked" onClick={remove}>
        Delete session
      </button>
      <span className="flex-1" />
      <span
        className={`text-[10.5px] transition-opacity duration-300 ${flash ? "opacity-100" : "opacity-0"}`}
        style={{ color: "var(--color-active)" }}
      >
        ✓ Saved
      </span>
      <span className="text-[10px] text-ink-muted/50">auto-saves · esc to close</span>
    </div>
  );

  // expanded = ticket view (design C): left = title + fields + specs, right = journal
  // with Resume/NEXT/composer pinned; below 1000px the panes stack into one document
  if (expanded || embedded) {
    const lblCls = "text-[11px] text-ink-muted";
    const projectPill = (() => {
                      const proj = board.projects.find((c) => c.name === client);
                      const c = proj ? clientColor(proj.name, proj.color) : null;
                      return c
                        ? (
                          <div className="w-fit min-w-[130px]">
                            <Select
                              value={client}
                              className="rounded-md px-2.5 py-1 text-xs font-medium outline-none"
                              triggerStyle={{ background: `${c}24`, color: c }}
                              options={[
                                { value: "", label: "none" },
                                ...board.projects.map((p) => ({ value: p.name, label: p.name, dot: clientColor(p.name, p.color), icon: p.icon })),
                              ]}
                              onChange={(v) => {
                                setClient(v);
                                commit({ client: v || undefined });
                              }}
                            />
                          </div>
                        )
                        : projectSelect;
                    })();
    return (
      <div className={embedded ? "flex min-h-0 flex-1 flex-col bg-canvas" : "fixed inset-0 z-50 flex flex-col bg-sidebar"}>
        {!embedded && headerBar}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto min-[1000px]:flex-row min-[1000px]:overflow-hidden">
          <div className="flex-1 px-8 pb-6 pt-3 min-[1000px]:min-h-0 min-[1000px]:overflow-y-auto">
            <div className="mx-auto flex max-w-[860px] flex-col gap-5">
              {embedded
                ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">{titleInput}</div>
                      {topSlot && createPortal(
                        <>
                          <button
                            type="button"
                            title={`Copy ${session.id}`}
                            className={TOP_BTN}
                            onClick={() =>
                              navigator.clipboard.writeText(session.id).then(
                                () => flashCopied("copied"),
                                () => flashCopied("clipboard blocked"),
                              )}
                          >
                            {copied ?? "⧉ Copy session id"}
                          </button>
                          <button type="button" className="shrink-0 whitespace-nowrap rounded-md border border-blocked/40 px-2.5 py-1 text-[11.5px] text-blocked hover:border-blocked" onClick={remove}>
                            ✕ Delete session
                          </button>
                        </>,
                        topSlot,
                      )}
                    </div>
                    {/* the fields as label / value rows, two columns on wide screens (row-major order) */}
                    <div className="grid grid-cols-1 gap-x-10 min-[900px]:grid-cols-2">
                      {([
                        ["Status", statusSelect],
                        ["Branch", branchInput],
                        ["Project", projectPill],
                        ["PR / MR", prField],
                        ["User story", storyPill],
                        ["Repo", (
                          session.repo_path
                            ? <RepoLink path={session.repo_path} prUrl={session.pr_url} />
                            : <span className="text-[12px] text-ink-faint">none</span>
                        )],
                        ["Last touched", (
                          <span className="text-[12px] text-ink-muted" title={new Date(session.last_touched).toLocaleString()}>
                            {timeAgo(session.last_touched)}
                          </span>
                        )],
                        ["Tags", sessionTags],
                      ] as [string, ReactNode][]).map(([label, value]) => (
                        <FieldRow key={label} label={label}>{value}</FieldRow>
                      ))}
                      {FRONTEND_PLUGINS.map((p) => p.CardFields && <p.CardFields key={p.id} session={session} specs={specContent} />)}
                      {/* full width: the expanded per-agent lines need more than half the grid */}
                      <div className="col-span-full grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3 py-1.5">
                        <span className="pt-1 text-[11.5px] text-ink-muted">Agents</span>
                        <div className="min-w-0"><AgentsSummary agents={agentSummaries} /></div>
                      </div>
                    </div>
                  </div>
                )
                : (
                  <>
              <div className="flex flex-col gap-2">
                {titleField}
                {sessionTags}
              </div>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-[minmax(120px,180px)_1fr_1fr] gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Status</span>
                    {statusSelect}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Project</span>
                    {projectPill}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>User story</span>
                    {storyRow}
                  </div>
                </div>
                <div className="grid grid-cols-[minmax(120px,240px)_1fr] gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Branch</span>
                    {branchInput}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>PR / MR</span>
                    {prField}
                  </div>
                </div>
              </div>
                  </>
                )}
              {linkedRow}
              <div className="max-w-[760px]">
                <SpecsEditor
                  sessionId={session.id}
                  specsPageId={session.specs_page_id}
                  onLinked={onSaved}
                  onOpenPage={(id) => {
                    onOpenPage?.(id);
                    onClose();
                  }}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col border-t border-line bg-panel min-[1000px]:min-h-0 min-[1000px]:w-[408px] min-[1000px]:border-l min-[1000px]:border-t-0">
            <div className="flex flex-col gap-3 border-b border-line px-4 py-4">
              <span className={sectionLbl}>JOURNAL</span>
              {resumeBlock}
              {nextBanner}
              {activityInput}
            </div>
            <div className="px-4 py-4 min-[1000px]:min-h-0 min-[1000px]:flex-1 min-[1000px]:overflow-y-auto">
              {renderFeed("border-panel")}
            </div>
          </div>
        </div>
        {!embedded && footerBar}
      </div>
    );
  }

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
      {headerBar}

      <div className="flex flex-col gap-3 px-4 pb-4">
        {titleField}
        {sessionTags}
        {statusSelect}
        {resumeBlock}
      </div>

      <div className="flex flex-col gap-1 border-t border-line-soft px-4 py-3.5">
        <Row label="Project">{projectSelect}</Row>
        <Row label="User story">{storyRow}</Row>
        <Row label="Branch">{branchInput}</Row>
        <Row label="PR / MR">{prField}</Row>

        {/* Next step — the imperative line for future-you, as a banner below the fields */}
        <div className="mt-2">{nextBanner}</div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 border-t border-line-soft px-4 py-3.5">
        <span className={sectionLbl}>ACTIVITY</span>
        {activityInput}
        {renderFeed("border-sidebar")}
      </div>

      {footerBar}
    </div>
  );
}
