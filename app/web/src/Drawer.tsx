import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  addLog,
  type BoardData,
  deleteSession,
  getEvents,
  openInBrowser,
  prState,
  probeResume,
  type ResumeInfo,
  type ResumeMode,
  resumeSession,
  saveSession,
  type Session,
  type SessionEvent,
  type Status,
} from "./api";
import { appConfirm, clientColor, pageOptions, Popover, Select, StatusDot, timeAgo } from "./ui";
import { Markdown } from "./md";

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
const SPECS_PLACEHOLDER = "- what this session must deliver\n- constraints, links, done-when…";
const rowLbl = "shrink-0 pt-[5px] text-[11px] text-ink-muted";

// PR/MR link chips: state colors + a short label (repo#42 / proj!39) parsed from the URL
const PR_STATE_COLOR: Record<string, string> = {
  open: "#7bd88f",
  draft: "#8b93a3",
  merged: "#b590e7",
  closed: "#e06c75",
  unknown: "#5a6172",
};
// journal attribution: which coding agent produced a track/import entry.
// Brand paths mirror app/agent-comments.ts (Simple Icons OpenAI v15.0.0 /
// Anthropic v16.21.0) — copied, not imported: web code never pulls server modules.
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const ANTHROPIC_PATH =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";
const AGENT_MARKS: Record<string, { title: string; bg: string; path: string }> = {
  claude: { title: "Claude Code", bg: "#D97757", path: ANTHROPIC_PATH },
  codex: { title: "Codex", bg: "#111827", path: OPENAI_PATH },
};
function AgentMark({ agent }: { agent: string }) {
  const m = AGENT_MARKS[agent];
  if (!m) return null;
  return (
    <svg width="13" height="13" viewBox="0 0 32 32" className="shrink-0">
      <title>{m.title}</title>
      <circle cx="16" cy="16" r="16" fill={m.bg} />
      <g transform="translate(5 5) scale(.9166667)" fill="white">
        <path d={m.path} />
      </g>
    </svg>
  );
}

// tab strip for consecutive "## Title {{tab}}" spec sections
function SpecTabs(
  { tabs, onEditItem }: {
    tabs: { heading: string; body: string }[];
    onEditItem: (item: string, next: string) => void;
  },
) {
  const [active, setActive] = useState(0);
  const cur = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 border-b border-line">
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
              i === active
                ? "border-copper font-medium text-copper"
                : "border-transparent text-ink-muted hover:text-ink-soft"
            }`}
            onClick={() => setActive(i)}
          >
            {t.heading}
          </button>
        ))}
      </div>
      <Markdown
        text={cur.body}
        className="text-[13px] leading-relaxed"
        onEditItem={onEditItem}
      />
    </div>
  );
}

// expand / collapse (full-screen) glyph — inline SVG so it renders on WebKitGTK
function ExpandIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d={open ? "M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" : "M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"} />
    </svg>
  );
}
function prLabel(url: string): string {
  try {
    const u = new URL(url);
    const mr = u.pathname.includes("/merge_requests/");
    const m = u.pathname.match(/\/([^/]+)\/(?:pull|-\/merge_requests)\/(\d+)/);
    return m ? `${m[1]}${mr ? "!" : "#"}${m[2]}` : `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
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

export function Drawer(
  { session, board, onClose, onSaved, defaultExpanded, onExpandedChange }: {
    session: Session;
    board: BoardData;
    onClose: () => void;
    onSaved: () => void;
    defaultExpanded?: boolean;
    onExpandedChange?: (v: boolean) => void; // App mirrors it into the URL
  },
) {
  const [title, setTitle] = useState(session.title);
  const [status, setStatus] = useState<Status>(session.status);
  const [client, setClient] = useState(board.projects.find((c) => c.id === session.client_id)?.name ?? "");
  const [pageId, setPageId] = useState(session.page_id ?? "");
  const [branch, setBranch] = useState(session.branch ?? "");
  const [nextStep, setNextStep] = useState(session.next_step ?? "");
  const [prUrl, setPrUrl] = useState(session.pr_url ?? "");
  const [prNew, setPrNew] = useState("");
  // ticket spec (markdown) — shown and edited in the expanded view only
  const [specs, setSpecs] = useState(session.specs ?? "");
  const [specsEditing, setSpecsEditing] = useState(false);
  const specsRef = useRef<HTMLTextAreaElement>(null);
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
  const [prStates, setPrStates] = useState<Record<string, string>>({});
  const prLinks = prUrl.split("\n").map((s) => s.trim()).filter(Boolean);
  const [events, setEvents] = useState<SessionEvent[]>([]);
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

  // resolve each PR/MR link's state (best-effort; server caches, GitHub via gh)
  useEffect(() => {
    for (const url of prLinks) {
      if (prStates[url]) continue;
      prState(url).then((state) => setPrStates((m) => ({ ...m, [url]: state })));
    }
  }, [prUrl]);

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
    // guard: a stale backend may answer an error object instead of an array
    getEvents(session.id).then((e) => Array.isArray(e) && setEvents(e)).catch(() => {});
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
      specs,
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
      getEvents(session.id).then((e) => Array.isArray(e) && setEvents(e)).catch(() => {});
      onSaved();
    });
  };

  const remove = async () => {
    if (await appConfirm(`Delete session "${session.title}"?`)) {
      deleteSession(session.id).then(onClose).then(onSaved);
    }
  };

  const growSpecs = () => {
    const el = specsRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    if (!specsEditing) return;
    growSpecs();
    const el = specsRef.current;
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [specsEditing]);
  // per-line edit from the rendered spec list (same contract as the page editor)
  const editSpecItem = (item: string, next: string) => {
    const re = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/;
    const lines = specs.split("\n");
    const li = lines.findIndex((l) => l.match(re)?.[2] === item);
    if (li < 0 || next === item) return;
    if (next.trim()) lines[li] = lines[li].match(re)![1] + next;
    else lines.splice(li, 1);
    const text = lines.join("\n");
    setSpecs(text);
    commit({ specs: text });
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
    <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
      <span className={sectionLbl}>SESSION</span>
      <span className="flex-1" />
      {session.repo_path && (
        <span className="truncate font-mono text-[10px] text-ink-muted/70" title={session.repo_path}>
          {session.repo_path.split("/").slice(-2).join("/")}
        </span>
      )}
      <button type="button"
        className="flex items-center rounded-md px-1.5 py-1 text-ink-muted transition-colors hover:bg-panel hover:text-ink"
        title={expanded ? "collapse to side panel" : "expand to full screen"}
        onClick={() => setExpanded((v) => !v)}
      >
        <ExpandIcon open={expanded} />
      </button>
      <button type="button"
        className="rounded-md px-1.5 py-0.5 text-[13px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
        title="close (esc)"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );

  const titleField = (
    <textarea
      className="field-sizing-content resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold leading-snug text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
      rows={2}
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => commitIf(title !== session.title)}
    />
  );

  const statusPills = (
    <div className="flex flex-wrap gap-1 rounded-lg bg-panel p-1">
      {board.statuses.map((def) => {
        const s = def.key;
        const active = status === s;
        return (
          <button type="button"
            key={def.id}
            onClick={() => {
              setStatus(s);
              commit({ status: s });
            }}
            className={`flex flex-1 basis-[calc(25%-0.25rem)] items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] transition-colors ${
              active ? "font-medium" : "text-ink-muted hover:text-ink-soft"
            }`}
            style={active
              ? {
                background: `color-mix(in srgb, ${def.color} 13%, transparent)`,
                color: def.color,
              }
              : undefined}
          >
            <StatusDot status={s} size={6} /> {def.label}
          </button>
        );
      })}
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
        ...board.projects.map((c) => ({ value: c.name, label: c.name, dot: clientColor(c.name, c.color) })),
      ]}
      onChange={(v) => {
        setClient(v);
        commit({ client: v || undefined });
      }}
    />
  );
  const storySelect = (
    <Select
      value={pageId}
      className={rowVal}
      options={[
        { value: "", label: "none" },
        ...pageOptions(board.stories, board.pages ?? []),
      ]}
      onChange={(v) => {
        setPageId(v);
        commit({ page_id: v || null });
      }}
    />
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
  const prField = (
    <div className="flex min-w-0 flex-col gap-1">
      {prLinks.map((url) => {
        const state = prStates[url] ?? "unknown";
        return (
          <div key={url} className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-panel">
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: PR_STATE_COLOR[state] ?? PR_STATE_COLOR.unknown }}
              title={state}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink" title={url}>
              {prLabel(url)}
            </span>
            {state !== "unknown" && <span className="shrink-0 text-[10px] text-ink-muted">{state}</span>}
            <button type="button"
              className="shrink-0 text-[11.5px] text-ink-muted transition-colors hover:text-copper"
              title="open in browser"
              onClick={() => openInBrowser(url)}
            >
              ↗
            </button>
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
        );
      })}
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
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
            {/* the entry's own agent wins; older track/import rows predate the
                column and fall back to the session's agent. Manual logs stay bare. */}
            {(() => {
              const a = e.agent ?? (e.kind !== "log" ? session.agent : null);
              return a && <AgentMark agent={a} />;
            })()}
            <span>
              <span className="font-medium text-ink-soft/90">{e.kind}</span> · {timeAgo(e.at)}
            </span>
          </div>
          {e.summary && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{e.summary}</p>
          )}
        </div>
      ))}
      {events.length === 0 && <span className="py-1 text-[11px] text-ink-muted/60">No entries yet</span>}
    </div>
  );

  // Explicit opt-in sectioning (fence-aware): "## Title {{fold}}" starts a
  // collapsible section, "## Title {{tab}}" a tab — consecutive tabs group into
  // one strip. Plain ## headings render normally, so agents writing ordinary
  // markdown never hide things by accident. Everything above the first marked
  // heading stays visible. Open/active state is a local convenience.
  const specSections = (() => {
    const lines = specs.split("\n");
    const out: { heading: string | null; kind: "fold" | "tab" | null; body: string[] }[] = [
      { heading: null, kind: null, body: [] },
    ];
    let fenced = false;
    for (const l of lines) {
      if (/^\s*```/.test(l)) fenced = !fenced;
      const h = !fenced && l.match(/^##\s+(.*)$/);
      const kind = h && h[1].match(/\{\{(fold|tab)\}\}/i);
      if (h && kind) {
        out.push({
          heading: h[1].replace(/\s*\{\{(fold|tab)\}\}\s*/i, " ").trim(),
          kind: kind[1].toLowerCase() as "fold" | "tab",
          body: [],
        });
      } else out.at(-1)!.body.push(l);
    }
    return out;
  })();
  const [openSecs, setOpenSecs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`trame:specsOpen:${session.id}`) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggleSec = (h: string) =>
    setOpenSecs((cur) => {
      const next = new Set(cur);
      if (next.has(h)) next.delete(h);
      else next.add(h);
      localStorage.setItem(`trame:specsOpen:${session.id}`, JSON.stringify([...next]));
      return next;
    });

  const specsSection = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={sectionLbl}>SPECS</span>
        <span className="flex-1" />
        {!specsEditing && specs.trim() && (
          <button type="button"
            title="edit raw markdown"
            className="rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
            onClick={() => setSpecsEditing(true)}
          >
            ✏️
          </button>
        )}
      </div>
      {specsEditing
        ? (
          <textarea
            ref={specsRef}
            autoFocus
            rows={3}
            className="w-full resize-none overflow-hidden rounded-md border border-chipline bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none placeholder:font-sans placeholder:text-ink-muted/60"
            value={specs}
            onChange={(e) => {
              setSpecs(e.target.value);
              growSpecs();
            }}
            onBlur={() => {
              setSpecsEditing(false);
              if (specs !== (session.specs ?? "")) commit({ specs });
            }}
            placeholder={SPECS_PLACEHOLDER}
          />
        )
        : specs.trim()
        ? (
          <>
            {(() => {
              const els: ReactNode[] = [];
              for (let i = 0; i < specSections.length;) {
                const sec = specSections[i];
                if (sec.kind === "tab") {
                  const group: { heading: string; body: string }[] = [];
                  while (i < specSections.length && specSections[i].kind === "tab") {
                    group.push({
                      heading: specSections[i].heading ?? "",
                      body: specSections[i].body.join("\n"),
                    });
                    i++;
                  }
                  els.push(<SpecTabs key={`tabs-${i}`} tabs={group} onEditItem={editSpecItem} />);
                  continue;
                }
                if (sec.heading === null) {
                  const text = sec.body.join("\n");
                  if (text.trim()) {
                    els.push(
                      <Markdown
                        key={i}
                        text={text}
                        className="text-[13px] leading-relaxed"
                        onEditItem={editSpecItem}
                      />,
                    );
                  }
                  i++;
                  continue;
                }
                els.push(
                  <div key={i} className="overflow-hidden rounded-lg border border-line-soft">
                    <button type="button"
                      className="flex w-full items-center gap-2 bg-panel px-3 py-2 text-left text-[12.5px] font-medium text-ink transition-colors hover:text-copper"
                      onClick={() => toggleSec(sec.heading!)}
                    >
                      <span className="text-[10px] text-ink-muted">
                        {openSecs.has(sec.heading!) ? "▾" : "▸"}
                      </span>
                      {sec.heading}
                    </button>
                    {openSecs.has(sec.heading!) && (
                      <div className="px-3.5 pb-3 pt-2">
                        <Markdown
                          text={sec.body.join("\n")}
                          className="text-[13px] leading-relaxed"
                          onEditItem={editSpecItem}
                        />
                      </div>
                    )}
                  </div>,
                );
                i++;
              }
              return els;
            })()}
            <button type="button"
              className="w-fit rounded-md border border-dashed border-chipline px-3 py-1.5 text-[12px] text-ink-muted/70 transition-colors hover:border-copper/60 hover:text-copper"
              onClick={() => {
                setSpecs(`${specs.replace(/\n*$/, "")}\n- `);
                setSpecsEditing(true);
              }}
            >
              ＋ add a spec…
            </button>
          </>
        )
        : (
          <button type="button"
            className="rounded-md border border-dashed border-chipline px-3 py-2 text-left text-[12.5px] text-ink-muted/70 transition-colors hover:border-copper/60 hover:text-copper"
            onClick={() => {
              setSpecs("- ");
              setSpecsEditing(true);
            }}
          >
            ＋ add specs…
          </button>
        )}
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
  if (expanded) {
    const lblCls = "text-[11px] text-ink-muted";
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-sidebar">
        {headerBar}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto min-[1000px]:flex-row min-[1000px]:overflow-hidden">
          <div className="flex-1 px-8 pb-6 pt-3 min-[1000px]:min-h-0 min-[1000px]:overflow-y-auto">
            <div className="mx-auto flex max-w-[860px] flex-col gap-5">
              {titleField}
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-[minmax(120px,180px)_1fr_1fr] gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Status</span>
                    {(() => {
                      const def = board.statuses.find((d) => d.key === status);
                      return (
                        <div className="w-fit min-w-[130px]">
                          <Select
                            value={status}
                            className="rounded-md px-2.5 py-1 text-xs font-medium outline-none"
                            triggerStyle={def
                              ? {
                                background: `color-mix(in srgb, ${def.color} 13%, transparent)`,
                                color: def.color,
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
                    })()}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Project</span>
                    {(() => {
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
                                ...board.projects.map((p) => ({ value: p.name, label: p.name, dot: clientColor(p.name, p.color) })),
                              ]}
                              onChange={(v) => {
                                setClient(v);
                                commit({ client: v || undefined });
                              }}
                            />
                          </div>
                        )
                        : projectSelect;
                    })()}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={lblCls}>Story</span>
                    {storySelect}
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
              <div className="max-w-[760px]">{specsSection}</div>
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
        {footerBar}
      </div>
    );
  }

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
      {headerBar}

      <div className="flex flex-col gap-3 px-4 pb-4">
        {titleField}
        {statusPills}
        {resumeBlock}
      </div>

      <div className="flex flex-col gap-1 border-t border-line-soft px-4 py-3.5">
        <Row label="Project">{projectSelect}</Row>
        <Row label="Story">{storySelect}</Row>
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
