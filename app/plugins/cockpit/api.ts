// Typed client for a Cockpit instance's /api/sync surface.
//
// Every call carries the bearer and a scope; the server intersects that scope
// with the token's own, so the plugin can never reach further than the token
// allows even if a mapping is wrong.
import { type Scope, scopeQuery } from "./scope.ts";

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

export class CockpitError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const trimUrl = (s: string) => s.trim().replace(/\/+$/, "");

async function call<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${trimUrl(baseUrl)}/api/sync${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) {
    throw new CockpitError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/**
 * One page of the delta for a scope. The caller advances its watermark with
 * `next_since` while `has_more`, then parks on `now` — always the SERVER's
 * clock, never the laptop's, since a few seconds of drift would skip tickets.
 */
export function fetchDelta(
  baseUrl: string,
  token: string,
  scope: Scope,
  since: string | null,
  limit = 100,
): Promise<Delta> {
  const q = [scopeQuery(scope), `limit=${limit}`];
  if (since) q.push(`since=${encodeURIComponent(since)}`);
  return call<Delta>(baseUrl, token, `/tickets?${q.join("&")}`);
}

/** Live references for a scope — the reconcile list (phase 3). */
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
