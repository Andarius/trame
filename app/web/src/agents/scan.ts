import { useEffect, useSyncExternalStore } from "react";
import { type ClaudeScan, type ClaudeSession, scanClaudeImport, setClaudeStarred } from "../api";

// the transcript scan per day range, shared by All sessions, Recent and the New terminal dialog
const scans = new Map<number, ClaudeScan>();
const pending = new Map<number, Promise<ClaudeScan>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const cachedScan = (days: number) => scans.get(days) ?? null;

// rescans (one request at a time per range); `clear` drops the shown result first
export function loadScan(days: number, clear = false) {
  if (clear && scans.delete(days)) notify();
  let p = pending.get(days);
  if (!p) {
    p = scanClaudeImport(days).finally(() => pending.delete(days));
    pending.set(days, p);
    void p.then((s) => {
      scans.set(days, s);
      notify();
    }, () => {});
  }
  return p;
}

export const subscribeScans = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// the last scan of `days`, rescanned once per mount
export function useScan(days: number) {
  const scan = useSyncExternalStore(subscribeScans, () => cachedScan(days));
  useEffect(() => void loadScan(days), [days]);
  return scan;
}

// flips a session's star in every cached scan at once, then saves it
export function starSession(s: ClaudeSession, starred: boolean) {
  for (const [days, scan] of scans) {
    const groups = scan.groups.map((g) => ({
      ...g,
      sessions: g.sessions.map((x) => (x.claudeId === s.claudeId ? { ...x, starred } : x)),
    }));
    scans.set(days, { ...scan, groups });
  }
  notify();
  // a failed save comes back with the next scan
  void setClaudeStarred(s.claudeId, starred, s.source).catch(() => {});
}
