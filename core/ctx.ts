// What every core function runs against: the app passes its PGlite, the hub one
// request's Postgres transaction and the calling device.

// The PGlite query shape; the hub adapts postgres.js to it.
export type Q = {
  // deno-lint-ignore no-explicit-any
  query<T = Record<string, any>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type Ctx = {
  q: Q;
  // node id stamped on every write (LWW origin; resolves owner_id through devices)
  origin: string;
  // tags stamped on stories minted for a repo path (TRACKER_CLIENTS on a laptop)
  defaultTags?: (repoPath: string) => string[];
  // where user-written formula SQL runs; the hub points it at a sandboxed role
  formula?: Q;
  // per-device author override (laptop settings.json), wins over the synced profile
  localAuthor?: () => Promise<{ name: string; avatar: string }>;
};
