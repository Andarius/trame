// Typed client for a Cockpit instance's /api/sync surface.
//
// Every call carries the bearer and a scope; the server intersects that scope
// with the token's own, so the plugin can never reach further than the token
// allows even if a mapping is wrong.
import { type Scope, scopeQuery } from "./scope.ts";

export type TicketStatus =
  | "todo"
  | "in_progress"
  | "to_verify"
  | "done"
  | "cancelled";

export type Ticket = {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  objective: string | null;
  design_figma_url: string | null;
  status: string;
  review_status: string | null;
  deployment_status: string | null;
  priority: number;
  scope: string | null;
  commit_type: string | null;
  standalone_section: string | null;
  user_story_id: string | null;
  product_id: string | null;
  flow_id: string | null;
  assignee_id: string | null;
  created_by: string | null;
  /** display name of `created_by`, when the server sends one */
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  meta: Record<string, unknown> | null;
};

export type Delta = {
  now: string;
  has_more: boolean;
  next_since: string | null;
  tickets: Ticket[];
};

export type Refs = { now: string; references: string[] };

/** What this token may sync — the server reads back its own grant. */
export type GrantedScope = {
  kind: "product" | "flow";
  slug: string;
  name: string;
};

export class CockpitError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const trimUrl = (s: string) => s.trim().replace(/\/+$/, "");

async function call<T>(
  baseUrl: string,
  token: string,
  path: string,
  init?: { method: string; body: string },
): Promise<T> {
  const res = await fetch(`${trimUrl(baseUrl)}/api/sync${path}`, {
    method: init?.method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init?.body,
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) {
    throw new CockpitError(
      res.status,
      body.error ?? `HTTP ${res.status}`,
      body,
    );
  }
  return body as T;
}

/** Live references for a scope — the reconcile list (phase 3). */
export type Created = {
  reference: string;
  updated_at: string;
  /** false when this origin_id had already produced a ticket */
  created: boolean;
};

/**
 * Deposit a ticket in a granted scope.
 *
 * `originId` is the Trame page id, and the server deduplicates on it: a retry
 * after a timeout returns the ticket the first call made rather than a second
 * one, so a flaky network cannot litter a shared tracker.
 */
export function createTicket(
  baseUrl: string,
  token: string,
  scope: Scope,
  body: {
    originId: string;
    title: string;
    objective: string;
    description: string | null;
    /** `US-…` reference of the user story the ticket files under, if any */
    userStory?: string | null;
    status?: TicketStatus;
    sourceStatus?: string;
  },
): Promise<Created> {
  return call(baseUrl, token, `/tickets/create?${scopeQuery(scope)}`, {
    method: "POST",
    body: JSON.stringify({
      origin_id: body.originId,
      title: body.title,
      objective: body.objective,
      description: body.description,
      user_story: body.userStory ?? null,
      status: body.status,
      source_status: body.sourceStatus,
    }),
  });
}

/** Create a user story — same idempotency contract as createTicket. */
export function createUserStory(
  baseUrl: string,
  token: string,
  scope: Scope,
  body: { originId: string; title: string; description: string | null },
): Promise<Created & { id: string }> {
  return call(baseUrl, token, `/user-stories/create?${scopeQuery(scope)}`, {
    method: "POST",
    body: JSON.stringify({
      origin_id: body.originId,
      title: body.title,
      description: body.description,
    }),
  });
}

export function fetchScopes(
  baseUrl: string,
  token: string,
): Promise<{
  scopes: GrantedScope[];
  /** the token owner, on servers that report it */
  user?: { id: string; name: string } | null;
  capabilities?: {
    initial_ticket_status?: boolean;
    user_story_ids?: boolean;
    tags?: boolean;
    assigned_to_me?: boolean;
  };
}> {
  return call(baseUrl, token, "/scopes");
}

export function fetchRefs(
  baseUrl: string,
  token: string,
  scope: Scope,
): Promise<Refs> {
  return call<Refs>(baseUrl, token, `/tickets/refs?${scopeQuery(scope)}`);
}

export type Probe =
  | { ok: true; detail: string }
  | { ok: false; kind: "auth" | "scope" | "network" | "http"; detail: string };

/**
 * Connection test, run from the settings pane before anything is saved.
 *
 * Deliberately asks for NO scope. The server authenticates first and only then
 * validates the query, so the status code distinguishes every failure mode
 * that matters — and the useful middle case (token valid, but nobody has
 * granted it a sync scope yet) is the one a first-time setup actually hits:
 *
 *   401 → token wrong or revoked
 *   403 → token fine, but it holds no sync scope
 *   400 → token fine AND scoped ("scope required" is the happy answer here)
 */
export async function probe(baseUrl: string, token: string): Promise<Probe> {
  if (!trimUrl(baseUrl)) {
    return { ok: false, kind: "network", detail: "no base URL" };
  }
  if (!token) return { ok: false, kind: "auth", detail: "no token" };
  let res: Response;
  try {
    res = await fetch(`${trimUrl(baseUrl)}/api/sync/tickets`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (e) {
    return {
      ok: false,
      kind: "network",
      detail: String((e as Error)?.message ?? e),
    };
  }
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (res.status === 400) {
    return { ok: true, detail: "authenticated, sync scope granted" };
  }
  if (res.status === 401) {
    return { ok: false, kind: "auth", detail: body.error ?? "token rejected" };
  }
  if (res.status === 403) {
    return {
      ok: false,
      kind: "scope",
      detail: body.error ?? "no sync scope on this token",
    };
  }
  return {
    ok: false,
    kind: "http",
    detail: body.error ?? `HTTP ${res.status}`,
  };
}

/** Read a complete scope, refusing a truncated or broken cursor. */
export function fetchTickets(
  baseUrl: string,
  token: string,
  scope: Scope,
): Promise<Ticket[]> {
  return drain<Ticket>(baseUrl, token, scopeQuery(scope), "tickets", "tickets");
}

/** Every ticket assigned to the token's user, any product or none. */
export function fetchAssignedTickets(
  baseUrl: string,
  token: string,
): Promise<Ticket[]> {
  return drain<Ticket>(baseUrl, token, "assignee=me", "tickets", "tickets");
}

/** A user story as the status sync needs it; archived ones read `archived`. */
export type UserStory = {
  id: string;
  reference: string;
  title: string;
  status: string;
  updated_at: string;
  archived_at: string | null;
  meta: Record<string, unknown> | null;
};

/** Every user story in a scope — same paging contract as the tickets. */
export function fetchUserStories(
  baseUrl: string,
  token: string,
  scope: Scope,
): Promise<UserStory[]> {
  return drain<UserStory>(
    baseUrl,
    token,
    scopeQuery(scope),
    "user-stories",
    "user_stories",
  );
}

// Pages by `next_since` — the SERVER's clock, never the laptop's.
async function drain<T>(
  baseUrl: string,
  token: string,
  query: string,
  path: string,
  key: string,
): Promise<T[]> {
  const items: T[] = [];
  let since: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = [query, "limit=100"];
    if (since) q.push(`since=${encodeURIComponent(since)}`);
    const delta = await call<
      Omit<Delta, "tickets"> & Record<string, T[] | undefined>
    >(baseUrl, token, `/${path}?${q.join("&")}`);
    items.push(...(delta[key] ?? []));
    if (!delta.has_more) return items;
    if (!delta.next_since || delta.next_since === since) {
      throw new Error("Cockpit returned an invalid cursor.");
    }
    since = delta.next_since;
  }
  throw new Error(`Cockpit ${path} scope exceeds the 20-page import limit.`);
}

/** Retain the original ticket beneath its converted US with an atomic retry receipt. */
export function attachLegacyTicket(
  baseUrl: string,
  token: string,
  reference: string,
  expectedUpdatedAt: string,
  userStory: string,
  pageId: string,
): Promise<{ reference: string; updated_at: string }> {
  return call(baseUrl, token, `/tickets/${encodeURIComponent(reference)}`, {
    method: "PATCH",
    body: JSON.stringify({
      expected_updated_at: expectedUpdatedAt,
      fields: { user_story_id: userStory },
      meta: { trame_migration: { page_id: pageId, user_story: userStory } },
    }),
  });
}

/**
 * Write a ticket's or user story's status (or, with `write` false, only record
 * it as synced) under `meta.trame_status`. Trame wins a 409: one retry.
 */
export async function syncStatus(
  baseUrl: string,
  token: string,
  resource: "tickets" | "user-stories",
  reference: string,
  expectedUpdatedAt: string,
  status: string,
  write: boolean,
): Promise<{ reference: string; updated_at: string }> {
  const patch = (at: string) =>
    call<{ reference: string; updated_at: string }>(
      baseUrl,
      token,
      `/${resource}/${encodeURIComponent(reference)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          expected_updated_at: at,
          ...(write ? { fields: { status } } : {}),
          meta: { trame_status: status },
        }),
      },
    );
  try {
    return await patch(expectedUpdatedAt);
  } catch (e) {
    const at = write && e instanceof CockpitError && e.status === 409
      ? (e.body as { current?: { updated_at?: string } } | undefined)?.current
        ?.updated_at
      : undefined;
    if (!at) throw e;
    return patch(at);
  }
}

/** Refuse exports to older servers that silently discard initial status fields. */
export async function requireImportSupport(
  baseUrl: string,
  token: string,
): Promise<{ tags: boolean }> {
  const { capabilities } = await fetchScopes(baseUrl, token);
  if (
    capabilities?.initial_ticket_status !== true ||
    capabilities.user_story_ids !== true
  ) {
    throw new Error(
      "Update Cockpit before exporting: its API does not support status-preserving imports and US identities yet.",
    );
  }
  return { tags: capabilities.tags === true };
}

/** Replace this source's tags without touching tags owned by Cockpit or other sources. */
export function syncTags(
  baseUrl: string,
  token: string,
  scope: Scope,
  item: { reference: string; sourceId: string; tags: string[] },
): Promise<{ reference: string; changed: boolean }> {
  return call(baseUrl, token, `/tags?${scopeQuery(scope)}`, {
    method: "POST",
    body: JSON.stringify({
      reference: item.reference,
      source_id: item.sourceId,
      tags: item.tags,
    }),
  });
}
