// Ephemeral "who's here" registry — in-memory, device-local, never synced. Viewers
// heartbeat while a page is open; the watcher heartbeats which agents it covers.
// Entries expire on a TTL so a closed tab or stopped watcher drops off on its own.

export type PresenceKind = "viewer" | "watcher";
export type Presence = {
  id: string;
  kind: PresenceKind;
  name: string;
  avatar: string;
  page_id: string; // "*" for a global watcher (covers every page)
};

const TTL_MS = 20_000;
const entries = new Map<string, Presence & { at: number }>();

export function touchPresence(p: Presence): void {
  entries.set(p.id, { ...p, at: Date.now() });
}

// Everyone on this page plus every active (global) watcher, freshest wins.
export function listPresence(pageId: string): Presence[] {
  const now = Date.now();
  const out: Presence[] = [];
  for (const [id, e] of entries) {
    if (now - e.at > TTL_MS) {
      entries.delete(id);
      continue;
    }
    if (e.kind === "watcher" || e.page_id === pageId) {
      const { at: _at, ...rest } = e;
      out.push(rest);
    }
  }
  return out;
}
