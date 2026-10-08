import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentPresenceSettings, deleteSession, getAgentPresence, getSettings, type LiveAgent, syncNow } from "./api";
import { type Live, liveAgents } from "./agents";
import { appConfirm, SET_CODEC, useLocalStorage } from "./ui";

/** Polls live agents every 5s and returns the memoised AgentsContext value. */
export function useAgentsPoll(settingsEpoch: number) {
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  const [tick, setTick] = useState(0); // re-derives liveness even when a poll fails
  const [presenceCfg, setPresenceCfg] = useState<AgentPresenceSettings | null>(null);
  useEffect(() => {
    getSettings().then((s) => setPresenceCfg(s.agentPresence)).catch(() => {});
  }, [settingsEpoch]);
  useEffect(() => {
    let busy = false; // one request at a time, so an old answer can't land last
    const load = () => {
      setTick((n) => n + 1);
      if (busy) return;
      busy = true;
      getAgentPresence()
        .then((next) => setAgents((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)))
        .catch(() => {})
        .finally(() => (busy = false));
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  // same states as before → same object, so the page editor doesn't re-render every poll
  const liveRef = useRef<
    { key: string; value: { live: Live[]; recent: LiveAgent[]; cfg: AgentPresenceSettings | null } }
  >();
  const agentsCtx = useMemo(() => {
    const live = liveAgents(agents, presenceCfg);
    const key = JSON.stringify([presenceCfg, live.map((l) => [l.a, l.state]), agents.map((a) => [a.session_id, a.name])]);
    if (liveRef.current?.key !== key) liveRef.current = { key, value: { live, recent: agents, cfg: presenceCfg } };
    return liveRef.current.value;
  }, [agents, presenceCfg, tick]);
  return agentsCtx;
}

/** Multi-select over sessions: cleared on view change, Escape and after delete. */
export function useSelection(view: string, refresh: () => void) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  useEffect(() => setSelected(new Set()), [view]);
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [selected.size]);
  const deleteSelected = async () => {
    const n = selected.size;
    if (!(await appConfirm(`Delete ${n} session${n > 1 ? "s" : ""}?`))) return;
    await Promise.all([...selected].map((id) => deleteSession(id).catch(() => {})));
    setSelected(new Set());
    refresh();
  };
  return { selected, setSelected, toggleSelected, selectMany, deleteSelected };
}

/** Sync-now with a short result flash. */
export function useSync(refresh: () => void) {
  const [syncing, setSyncing] = useState(false);
  const [syncFlash, setSyncFlash] = useState<string | null>(null);
  const syncFlashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doSync = async () => {
    if (syncing) return;
    setSyncing(true);
    let msg: string;
    try {
      const r = await syncNow();
      refresh();
      msg = r
        ? (r.pulled || r.pushed ? `${r.pulled}↓ ${r.pushed}↑` : "up to date")
        : "offline";
    } catch {
      msg = "failed";
    } finally {
      setSyncing(false);
    }
    setSyncFlash(msg);
    clearTimeout(syncFlashTimer.current);
    syncFlashTimer.current = setTimeout(() => setSyncFlash(null), 2500);
  };
  useEffect(() => () => clearTimeout(syncFlashTimer.current), []);
  return { syncing, syncFlash, doSync };
}

/** Per-browser starred page ids. */
export function useStarred() {
  const [starred, setStarred] = useLocalStorage("trame:starred", new Set<string>(), SET_CODEC);
  const toggleStar = (id: string) =>
    setStarred((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return { starred, toggleStar };
}
