// Cockpit plugin: a lens on the tickets a Cockpit instance lets us see, and
// optionally a mirror of them as story pages. No writes back to Cockpit yet —
// that is phase 4.
//
// Like `deployments`, live state is a module-level cache fed by a
// self-rescheduling poll. Mirroring is the one thing that reaches PGlite, and
// it stays off until a mapping names a project AND `mirror` is switched on:
// what lands in the local database syncs to the hub and can be shared by link,
// so it is never a side effect of merely enabling the plugin.
import { COCKPIT_FIXTURE, COCKPIT_POLL_IDLE_MS } from "../../config.ts";
import type { Plugin, PluginSettings } from "../types.ts";
import { getPluginSettings, isPluginEnabled } from "../settings.ts";
import { ensureTag, tagKey } from "../../db.ts";
import {
  type Mapping,
  mappingTagLabel,
  parseMappings,
  type Scope,
  scopeKey,
  scopeOf,
} from "./scope.ts";
import {
  CockpitError,
  createTicket,
  fetchDelta,
  fetchRefs,
  fetchScopes,
  probe,
  type Ticket,
} from "./api.ts";
import { groupByProject, planMirror, ticketFromPage } from "./mirror.ts";
import {
  adoptAsMirror,
  applyMirror,
  loadMirrorPages,
  loadPendingPages,
  loadSyncedPages,
  type MirrorResult,
} from "./mirror-store.ts";

const ID = "cockpit";
const DEFAULT_IDLE_SECONDS = COCKPIT_POLL_IDLE_MS / 1000;
const MIN_IDLE_SECONDS = 30;
const MAX_PAGES = 20; // guard: a broken cursor must not loop forever

// `mapping`, not `scope`: a Cockpit ticket ALREADY has a `scope` field
// (front | back | product), and reusing the name would silently overwrite it.
export type ScopedTicket = Ticket & { mapping: string };

export type CockpitState = {
  configured: boolean;
  // Where the tickets came from, so the panel can deep-link. The token is
  // never part of state — only this host is.
  baseUrl: string;
  tickets: ScopedTicket[];
  polledAt: string | null;
  errors: { scope: string; error: string }[];
  // What the last pass wrote into Trame, per mapping. Empty while mirroring is
  // off, which is the default.
  mirrored: ({ pageId: string; scopes: string[] } & MirrorResult)[];
  // Pages this pass pushed INTO Cockpit, newest pass only.
  filed: { title: string; reference: string }[];
};

let state: CockpitState = {
  configured: false,
  baseUrl: "",
  tickets: [],
  polledAt: null,
  errors: [],
  mirrored: [],
  filed: [],
};
let pollRunning: Promise<CockpitState> | null = null;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const clampIdle = (n: number) => Math.max(MIN_IDLE_SECONDS, Math.round(n));

async function idlePollMs(): Promise<number> {
  const s = await getPluginSettings(ID);
  return typeof s.pollIdleSeconds === "number"
    ? clampIdle(s.pollIdleSeconds) * 1000
    : COCKPIT_POLL_IDLE_MS;
}

// Urgent first, then oldest-touched — the same "what needs me" ordering the
// deployments panel uses.
const STATUS_RANK: Record<string, number> = {
  to_fix: 0,
  in_progress: 1,
  to_verify: 2,
  todo: 3,
  done: 4,
  cancelled: 5,
};
const ordered = (items: ScopedTicket[]) =>
  items.sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
      b.priority - a.priority ||
      b.updated_at.localeCompare(a.updated_at),
  );

/**
 * Drain one scope's delta.
 *
 * Phase 2 keeps no watermark: the panel is a live view, so each pass starts
 * from scratch and the cache is whatever the server last said. Watermarks
 * arrive with mirroring in phase 3, where re-reading everything would mean
 * rewriting every page on every tick.
 */
async function drain(
  baseUrl: string,
  token: string,
  scope: Scope,
): Promise<Ticket[]> {
  const out: Ticket[] = [];
  let since: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const delta = await fetchDelta(baseUrl, token, scope, since);
    out.push(...delta.tickets);
    if (!delta.has_more || !delta.next_since) break;
    since = delta.next_since;
  }
  return out;
}

/**
 * Mirror one project's group — see `groupByProject` for why the unit is the
 * project and not the mapping.
 *
 * `/refs` is what tells us a ticket left the scope. If ANY scope in the group
 * fails that call we pass null rather than a partial union, and the planner
 * then removes nothing — a partial answer is indistinguishable from "those
 * tickets disappeared", and would retire a product whose server merely
 * hiccuped.
 */
async function mirror(
  baseUrl: string,
  token: string,
  scopes: Scope[],
  pageId: string,
  tickets: Ticket[],
  tagsByRef: ReadonlyMap<string, string[]>,
): Promise<MirrorResult> {
  // No scope at all means we were told nothing — null, not an empty union.
  // An empty ARRAY would read as "no ticket is live" and retire every page.
  let live: string[] | null = scopes.length ? [] : null;
  for (const scope of scopes) {
    try {
      const refs = (await fetchRefs(baseUrl, token, scope)).references;
      if (live) live.push(...refs);
    } catch {
      live = null; // one unknown scope makes the whole union unusable
    }
  }

  const existing = await loadMirrorPages(pageId);
  return applyMirror(pageId, planMirror(tickets, existing, live, tagsByRef));
}

async function pollOnce(): Promise<CockpitState> {
  if (COCKPIT_FIXTURE) {
    const fixture = JSON.parse(await Deno.readTextFile(COCKPIT_FIXTURE));
    return (state = {
      configured: true,
      baseUrl: str((fixture as { baseUrl?: unknown }).baseUrl),
      tickets: ordered((fixture.tickets ?? []) as ScopedTicket[]),
      polledAt: new Date().toISOString(),
      errors: (fixture.errors ?? []) as CockpitState["errors"],
      mirrored: [],
      filed: [],
    });
  }

  const slice = await getPluginSettings(ID);
  const baseUrl = str(slice.baseUrl);
  const token = str(slice.token);
  const mappings = parseMappings(slice.projects);

  // No mapping → no request at all. This is the fail-closed rule that keeps
  // unrelated tickets off this machine entirely.
  if (!baseUrl || !token || mappings.length === 0) {
    return (state = {
      configured: false,
      baseUrl,
      tickets: [],
      polledAt: new Date().toISOString(),
      errors: [],
      mirrored: [],
      filed: [],
    });
  }

  const errors: CockpitState["errors"] = [];
  const mirrored: CockpitState["mirrored"] = [];
  const filed: CockpitState["filed"] = [];
  const wantsMirror = slice.mirror === true;

  // Push BEFORE pulling: a page filed now comes back in the same pass as a
  // ticket, so one poll leaves Trame and Cockpit agreeing instead of two.
  if (slice.autoFile !== false) {
    const pending = await loadPendingPages(
      mappings.map((m) => ({
        pageId: m.pageId,
        tagKey: tagKey(mappingTagLabel(m)),
        tagLabel: mappingTagLabel(m),
      })),
    );
    for (const page of pending) {
      try {
        const out = await filePage(baseUrl, token, mappings, page.pageId);
        if ("error" in out) {
          errors.push({ scope: page.title, error: out.error });
        } else {
          filed.push({ title: page.title, reference: out.reference });
        }
      } catch (e) {
        // One page failing must not stop the rest, nor the pull that follows.
        errors.push({
          scope: page.title,
          error: e instanceof CockpitError
            ? `${e.status} — ${e.message}`
            : String((e as Error)?.message ?? e),
        });
      }
    }
  }

  // Drain first, mirror second. Mirroring is grouped by target project below,
  // so it cannot start until every scope aiming at that project has answered.
  const drained = await Promise.all(
    mappings.map(async (m: Mapping) => {
      const scope = scopeOf(m)!; // parseMappings dropped the malformed ones
      const key = scopeKey(scope);
      try {
        return { m, scope, key, tickets: await drain(baseUrl, token, scope) };
      } catch (e) {
        const detail = e instanceof CockpitError
          ? `${e.status} — ${e.message}`
          : String((e as Error)?.message ?? e);
        errors.push({ scope: key, error: detail });
        return { m, scope, key, tickets: [] as Ticket[], failed: true };
      }
    }),
  );

  if (wantsMirror) {
    const groups = groupByProject(
      drained.map((d) => ({
        pageId: d.m.pageId,
        scope: d.scope,
        // The mapping names the tag — the scope's slug by default, always
        // under `cockpit:` — so a shared project says which product each
        // page came from, and says that Cockpit is where it came from.
        tag: tagKey(mappingTagLabel(d.m)),
        tickets: d.tickets,
        failed: "failed" in d,
      })),
    );

    for (const g of groups) {
      const keys = g.scopes.map(scopeKey);
      try {
        // The vocabulary row must exist before a page references its key,
        // or the chip renders as a bare slug until someone creates it.
        for (const m of mappings) {
          if (m.pageId === g.pageId) {
            await ensureTag({ label: mappingTagLabel(m) });
          }
        }
        mirrored.push({
          pageId: g.pageId,
          scopes: keys,
          // refScopes is empty when a scope failed to load — see groupByProject.
          ...await mirror(
            baseUrl,
            token,
            g.refScopes,
            g.pageId,
            g.tickets,
            g.tagsByRef,
          ),
        });
      } catch (e) {
        // A mirroring failure must not discard the tickets we just read — the
        // panel stays useful even when writing pages does not work.
        errors.push({
          scope: keys.join(", "),
          error: `mirroring — ${String((e as Error)?.message ?? e)}`,
        });
      }
    }
  }

  const results = drained.map((d) =>
    d.tickets.map((t) => ({ ...t, mapping: d.key }))
  );

  return (state = {
    configured: true,
    baseUrl,
    tickets: ordered(results.flat()),
    polledAt: new Date().toISOString(),
    errors,
    mirrored,
    filed,
  });
}

/**
 * File one Trame page as a Cockpit ticket, and stamp it with the reference.
 *
 * The scope comes from the mapping on the page's project — a page can only
 * ever reach a scope this device was told to sync. The stamp is what stops the
 * next pass from making a second ticket beside it.
 */
async function filePage(
  baseUrl: string,
  token: string,
  mappings: Mapping[],
  pageId: string,
): Promise<
  { reference: string; created: boolean } | { error: string; status: number }
> {
  const { getPage } = await import("../../pages.ts");
  const page = await getPage(pageId) as unknown as {
    id: string;
    title: string;
    brief?: string;
    content: unknown[];
    parent_id: string | null;
  } | null;
  if (!page) return { error: "unknown page", status: 404 };

  const mapping = mappings.find((m) => m.pageId === page.parent_id);
  const scope = mapping && scopeOf(mapping);
  if (!scope) {
    return { error: "This page is not under a mapped project.", status: 400 };
  }

  const fields = ticketFromPage(page);
  if ("error" in fields) return { error: fields.error, status: 422 };

  const made = await createTicket(baseUrl, token, scope, fields);
  await adoptAsMirror(pageId, made.reference);
  return made;
}

// Coalesce concurrent polls (refresh clicked while the interval tick runs).
function poll(): Promise<CockpitState> {
  pollRunning ??= pollOnce().finally(() => (pollRunning = null));
  return pollRunning;
}

const cockpit: Plugin = {
  id: ID,
  label: "Cockpit",
  glyph: "⌗",
  description: "Tickets from the projects you map, read-only.",
  // Usable from the settings pane before the plugin is switched on.
  ungatedRoutes: ["/test", "/scopes"],

  badge: () =>
    state.tickets.filter((t) =>
      t.status === "in_progress" || t.status === "to_fix"
    )
      .length || null,

  onEnabled() {
    poll().catch(console.error);
  },

  start() {
    const loop = async () => {
      if (await isPluginEnabled(ID)) { // toggle applies next tick
        await poll().catch(console.error);
      }
      setTimeout(loop, await idlePollMs());
    };
    loop();
  },

  async routes(req, subPath) {
    if (subPath === "/state") return json(state);
    // What actually reached Cockpit, read off the pages themselves rather than
    // off the last poll: the answer must survive a restart, and a page filed
    // by another device arrives through sync with its mark already on it.
    if (subPath === "/synced") {
      const s = await getPluginSettings(ID);
      const mappings = parseMappings(s.projects).map((m) => ({
        pageId: m.pageId,
        tagKey: tagKey(mappingTagLabel(m)),
        tagLabel: mappingTagLabel(m),
      }));
      return json({
        baseUrl: str(s.baseUrl),
        pages: await loadSyncedPages(),
        pending: await loadPendingPages(mappings),
      });
    }
    // The slugs this token may map. Offering them beats a free-text field: a
    // typo there returns no tickets, which looks exactly like an empty scope.
    if (subPath === "/scopes") {
      const s = await getPluginSettings(ID);
      const baseUrl = str(s.baseUrl);
      const token = str(s.token);
      if (!baseUrl || !token) return json({ scopes: [] });
      try {
        return json(await fetchScopes(baseUrl, token));
      } catch (e) {
        return json({
          scopes: [],
          error: e instanceof CockpitError
            ? `${e.status} — ${e.message}`
            : String((e as Error)?.message ?? e),
        });
      }
    }
    // Push a local page INTO Cockpit as a ticket. Explicit on purpose: this
    // files a row in a shared team tracker, so it must never happen because a
    // project happens to be mapped.
    if (subPath === "/create" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const pageId = str(body.pageId);
      if (!pageId) return json({ error: "pageId required" }, 400);

      const slice = await getPluginSettings(ID);
      const baseUrl = str(slice.baseUrl);
      const token = str(slice.token);
      if (!baseUrl || !token) return json({ error: "not configured" }, 400);

      try {
        const out = await filePage(
          baseUrl,
          token,
          parseMappings(slice.projects),
          pageId,
        );
        if ("error" in out) return json({ error: out.error }, out.status);
        poll().catch(console.error);
        return json(out);
      } catch (e) {
        const detail = e instanceof CockpitError
          ? `${e.status} — ${e.message}`
          : String((e as Error)?.message ?? e);
        return json({ error: detail }, 502);
      }
    }
    if (subPath === "/refresh" && req.method === "POST") {
      return json(await poll());
    }
    // Probe with the form's values, saving nothing — same contract as the
    // deployments /test route.
    if (subPath === "/test" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (COCKPIT_FIXTURE) {
        return json({ ok: true, detail: "fixture" });
      }
      const stored = await getPluginSettings(ID);
      const baseUrl = str(body.baseUrl) || str(stored.baseUrl);
      // A blank token in the form means "use the saved one" — but never send
      // the saved token to a host the caller just changed.
      const typed = str(body.token);
      const hostChanged = baseUrl !== str(stored.baseUrl);
      const token = typed || (hostChanged ? "" : str(stored.token));
      if (!token) {
        return json({
          ok: false,
          kind: "auth",
          detail: "no token for this host",
        });
      }
      return json(await probe(baseUrl, token));
    }
    return null;
  },

  sanitizeSettings(raw, current) {
    const patch: PluginSettings = {};
    if (typeof raw.baseUrl === "string") patch.baseUrl = str(raw.baseUrl);
    if ("projects" in raw) patch.projects = parseMappings(raw.projects);
    // Mirroring writes to the Trame database, so it is opt-in: absent means off.
    if ("mirror" in raw) patch.mirror = raw.mirror === true;
    // Filing is opt-OUT: a tag on a mapped page means "this belongs in
    // Cockpit", and making that wait for a second gesture was the wrong call.
    if ("autoFile" in raw) patch.autoFile = raw.autoFile !== false;
    if ("pollIdleSeconds" in raw) {
      const n = Number(raw.pollIdleSeconds);
      if (Number.isFinite(n) && n > 0) patch.pollIdleSeconds = clampIdle(n);
    }
    // The token is BOUND to its base URL: changing the host without supplying a
    // new token clears it, so a swapped baseUrl can never make the poller send
    // the saved bearer to another server.
    const curBase = str(current.baseUrl);
    const hostChanged = typeof patch.baseUrl === "string" &&
      patch.baseUrl !== curBase;
    if (typeof raw.token === "string" && raw.token.trim()) {
      patch.token = raw.token.trim();
    } else if (raw.clearToken === true || hostChanged) {
      patch.token = "";
    } else if (typeof current.token === "string") {
      patch.token = current.token;
    }
    return patch;
  },

  settingsView(slice) {
    return {
      baseUrl: str(slice.baseUrl),
      // The resolved tag travels with the mapping: the key is what a page
      // actually stores, and deriving it a second time in the browser would
      // be one slug rule to keep in step forever.
      projects: parseMappings(slice.projects).map((m) => ({
        ...m,
        tagLabel: mappingTagLabel(m),
        tagKey: tagKey(mappingTagLabel(m)),
      })),
      hasToken: Boolean(str(slice.token)),
      mirror: slice.mirror === true,
      autoFile: slice.autoFile !== false,
      pollIdleSeconds: typeof slice.pollIdleSeconds === "number"
        ? slice.pollIdleSeconds
        : DEFAULT_IDLE_SECONDS,
    };
  },
};

export default cockpit;
