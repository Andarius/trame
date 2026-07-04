import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  addLog,
  type BoardData,
  deleteSession,
  getEvents,
  openInBrowser,
  saveSession,
  type Session,
  type SessionEvent,
  type Status,
} from "./api";
import { appConfirm, Select, STATUS, StatusDot, timeAgo } from "./ui";

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

export function Drawer(
  { session, board, onClose, onSaved }: {
    session: Session;
    board: BoardData;
    onClose: () => void;
    onSaved: () => void;
  },
) {
  const [title, setTitle] = useState(session.title);
  const [status, setStatus] = useState<Status>(session.status);
  const [client, setClient] = useState(board.clients.find((c) => c.id === session.client_id)?.name ?? "");
  const [objective, setObjective] = useState(
    board.objectives.find((o) => o.id === session.objective_id)?.title ?? "",
  );
  const [branch, setBranch] = useState(session.branch ?? "");
  const [nextStep, setNextStep] = useState(session.next_step ?? "");
  const [prUrl, setPrUrl] = useState(session.pr_url ?? "");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [log, setLog] = useState("");
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // guard: a stale backend may answer an error object instead of an array
    getEvents(session.id).then((e) => Array.isArray(e) && setEvents(e)).catch(() => {});
    return () => clearTimeout(flashTimer.current);
  }, [session.id]);

  const commit = (over: Record<string, unknown> = {}) =>
    saveSession({
      id: session.id,
      title,
      status,
      client: client || undefined,
      objective: objective || undefined,
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
      getEvents(session.id).then((e) => Array.isArray(e) && setEvents(e)).catch(() => {});
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

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
        <span className={sectionLbl}>SESSION</span>
        <span className="flex-1" />
        {session.repo_path && (
          <span className="truncate font-mono text-[10px] text-ink-muted/70" title={session.repo_path}>
            {session.repo_path.split("/").slice(-2).join("/")}
          </span>
        )}
        <button
          className="rounded-md px-1.5 py-0.5 text-[13px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
          title="close (esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <textarea
          className="field-sizing-content resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold leading-snug text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
          rows={2}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => commitIf(title !== session.title)}
        />

        <div className="grid grid-cols-4 gap-1 rounded-lg bg-panel p-1">
          {(Object.keys(STATUS) as Status[]).map((s) => {
            const active = status === s;
            return (
              <button
                key={s}
                onClick={() => {
                  setStatus(s);
                  commit({ status: s });
                }}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] transition-colors ${
                  active ? "font-medium" : "text-ink-muted hover:text-ink-soft"
                }`}
                style={active
                  ? {
                    background: `color-mix(in srgb, ${STATUS[s].color} 13%, transparent)`,
                    color: STATUS[s].color,
                  }
                  : undefined}
              >
                <StatusDot status={s} size={6} /> {STATUS[s].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-line-soft px-4 py-3.5">
        <Row label="Client">
          <Select
            value={client}
            className={rowVal}
            options={[
              { value: "", label: "none" },
              ...board.clients.map((c) => ({ value: c.name, label: c.name })),
            ]}
            onChange={(v) => {
              setClient(v);
              commit({ client: v || undefined });
            }}
          />
        </Row>
        <Row label="Project">
          <Select
            value={objective}
            className={rowVal}
            options={[
              { value: "", label: "none" },
              ...board.objectives.map((o) => ({ value: o.title, label: `◎ ${o.title}` })),
            ]}
            onChange={(v) => {
              setObjective(v);
              commit({ objective: v || undefined });
            }}
          />
        </Row>
        <Row label="Branch">
          <input
            className={`${rowVal} font-mono text-[11px]`}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onBlur={() => commitIf(branch !== (session.branch ?? ""))}
            placeholder="none"
          />
        </Row>
        <Row label="PR / MR">
          <div className="flex items-center gap-1">
            <input
              className={`${rowVal} flex-1`}
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              onBlur={() => commitIf(prUrl !== (session.pr_url ?? ""))}
              placeholder="https://…"
            />
            {prUrl && (
              <button
                className="rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-muted transition-colors hover:bg-panel hover:text-copper"
                title="open in browser"
                onClick={() => openInBrowser(prUrl)}
              >
                ↗
              </button>
            )}
          </div>
        </Row>
        <Row label="Next step">
          <input
            className={rowVal}
            value={nextStep}
            onChange={(e) => setNextStep(e.target.value)}
            onBlur={() => commitIf(nextStep !== (session.next_step ?? ""))}
            placeholder="one imperative line"
          />
        </Row>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 border-t border-line-soft px-4 py-3.5">
        <span className={sectionLbl}>ACTIVITY</span>
        <input
          className="rounded-lg border border-chipline/70 bg-panel px-2.5 py-[7px] text-xs text-ink outline-none transition-colors placeholder:text-ink-muted/60 focus:border-copper/50"
          value={log}
          onChange={(e) => setLog(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitLog()}
          placeholder="Log what happened… ↵"
        />
        <div className={`ml-[3px] flex flex-col gap-3.5 pl-3.5 pt-1 ${events.length ? "border-l border-line" : ""}`}>
          {events.map((e) => (
            <div key={e.id} className="relative">
              <span className="absolute -left-[18px] top-[4px] h-[7px] w-[7px] rounded-full border-2 border-sidebar bg-chipline" />
              <div className="text-[10.5px] text-ink-muted">
                <span className="font-medium text-ink-soft/90">{e.kind}</span> · {timeAgo(e.at)}
              </div>
              {e.summary && (
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{e.summary}</p>
              )}
            </div>
          ))}
          {events.length === 0 && <span className="py-1 text-[11px] text-ink-muted/60">No entries yet</span>}
        </div>
      </div>

      <div className="sticky bottom-0 mt-auto flex items-center gap-2 border-t border-line bg-sidebar px-4 py-2.5">
        <button className="text-[11px] text-ink-muted transition-colors hover:text-blocked" onClick={remove}>
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
    </div>
  );
}
