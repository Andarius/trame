import { useEffect, useState } from "react";
import {
  type AppStatus,
  type BoardData,
  getBoard,
  getStatus,
  setStatus as apiSetStatus,
  type Status,
  syncNow,
} from "./api";
import { Board } from "./Board";
import { Drawer } from "./Drawer";
import { Explore } from "./Explore";
import { List } from "./List";
import { NewObjectiveModal, NewSessionModal, SettingsModal } from "./modals";
import { Objectives } from "./Objectives";

type View = "board" | "list" | "objectives" | "explore";

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function LogoMark() {
  return (
    <span className="relative inline-block h-[26px] w-[26px] shrink-0 rounded-[7px] bg-copper">
      <span className="absolute left-[6px] top-[11px] h-[3.5px] w-[14px] rounded-sm bg-copper-ink/85" />
      <span className="absolute left-[11.5px] top-[6px] h-[14px] w-[3.5px] rounded-sm bg-copper-ink/55" />
    </span>
  );
}

const NAV: { key: "sessions" | "objectives" | "explore"; glyph: string; label: string; view: View }[] = [
  { key: "sessions", glyph: "▦", label: "Sessions", view: "board" },
  { key: "objectives", glyph: "◎", label: "Objectives", view: "objectives" },
  { key: "explore", glyph: "✦", label: "Explore", view: "explore" },
];

function Sidebar(
  { view, onNav, status, onSettings }: {
    view: View;
    onNav: (v: View) => void;
    status: AppStatus | null;
    onSettings: () => void;
  },
) {
  const activeKey = view === "board" || view === "list" ? "sessions" : view;
  const synced = status?.remote && status.lastSync;
  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-1 border-r border-line bg-sidebar px-3 pb-3 pt-4">
      <div className="mb-3 flex items-center gap-2.5 px-2">
        <LogoMark />
        <span className="text-[15px] font-semibold">Trame</span>
      </div>
      <div className="px-2 pb-1.5 pt-0.5 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        VIEWS
      </div>
      {NAV.map((item) => {
        const active = item.key === activeKey;
        return (
          <button
            key={item.key}
            onClick={() => onNav(item.view)}
            className={`flex items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13.5px] ${
              active ? "bg-[#1a1d26] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>{item.glyph}</span>
            {item.label}
          </button>
        );
      })}
      <div className="flex-1" />
      <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-ink-muted">
        <span
          className="h-[7px] w-[7px] rounded-full"
          style={{ background: synced ? "var(--color-active)" : "var(--color-done)" }}
        />
        <span className="flex-1">
          {status
            ? status.remote
              ? status.lastSync ? `Synced · ${status.nodeId}` : "Sync pending…"
              : `Local only · ${status.nodeId}`
            : "…"}
        </span>
        <button className="text-[13px] text-ink-muted hover:text-ink-soft" title="Settings" onClick={onSettings}>
          ⚙
        </button>
      </div>
    </aside>
  );
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>((params.get("view") as View) ?? "board");
  const [group, setGroup] = useState<"none" | "objective">(
    params.get("group") === "objective" ? "objective" : "none",
  );
  const [modal, setModal] = useState<"session" | "objective" | "settings" | null>(
    (params.get("new") as "session" | "objective" | "settings" | null) ?? null,
  );
  const [openId, setOpenId] = useState<string | null>(params.get("session"));
  const [exploreEpoch, setExploreEpoch] = useState(0); // bump to rescan files after settings change

  const refresh = () => {
    getBoard().then(setBoard).catch(() => {});
    getStatus().then(setStatus).catch(() => {});
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const onMove = (id: string, s: Status) => {
    setBoard((b) => b ? { ...b, sessions: b.sessions.map((x) => x.id === id ? { ...x, status: s } : x) } : b);
    apiSetStatus(id, s).then(refresh).catch(refresh);
  };
  const createSession = (s: Record<string, unknown>) =>
    post("/api/sessions", s).then(() => {
      setModal(null);
      refresh();
    });
  const createObjective = (o: Record<string, unknown>) =>
    post("/api/objectives", o).then(() => {
      setModal(null);
      refresh();
    });

  const isSessions = view === "board" || view === "list";
  const title = isSessions ? "Sessions" : view === "objectives" ? "Objectives" : "Explore";

  return (
    <div className="flex h-full">
      <Sidebar view={view} onNav={setView} status={status} onSettings={() => setModal("settings")} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          <h1 className="text-[15px] font-semibold">{title}</h1>
          {isSessions && (
            <div className="flex rounded-[7px] bg-panel p-[3px]">
              {(["board", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-[5px] px-2.5 py-[3px] text-xs capitalize ${
                    view === v ? "bg-[#272b37] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          {view === "board" && (
            <button
              onClick={() => setGroup(group === "none" ? "objective" : "none")}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
            >
              Group · {group === "none" ? "None" : "Objective"} <span className="text-[8px]">▾</span>
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={() => syncNow().then(refresh)}
            className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
          >
            Sync now
          </button>
          {view !== "explore" && (
            <button
              onClick={() => setModal(isSessions ? "session" : "objective")}
              className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
            >
              <span>+</span> {isSessions ? "New session" : "New objective"}
            </button>
          )}
        </header>
        {!board
          ? <p className="p-6 text-ink-muted">Loading…</p>
          : view === "board"
          ? <Board board={board} group={group} onMove={onMove} onOpen={setOpenId} />
          : view === "list"
          ? <List board={board} onOpen={setOpenId} />
          : view === "objectives"
          ? <Objectives board={board} onOpen={setOpenId} onSaved={refresh} />
          : <Explore key={exploreEpoch} board={board} onOpenSettings={() => setModal("settings")} />}
      </main>
      {openId && board && (() => {
        const session = board.sessions.find((s) => s.id === openId);
        return session
          ? (
            <Drawer
              key={session.id}
              session={session}
              board={board}
              onClose={() => setOpenId(null)}
              onSaved={refresh}
            />
          )
          : null;
      })()}
      {modal === "session" && board && (
        <NewSessionModal board={board} onClose={() => setModal(null)} onCreate={createSession} />
      )}
      {modal === "objective" && board && (
        <NewObjectiveModal board={board} onClose={() => setModal(null)} onCreate={createObjective} />
      )}
      {modal === "settings" && (
        <SettingsModal onClose={() => setModal(null)} onSaved={() => setExploreEpoch((e) => e + 1)} />
      )}
    </div>
  );
}
