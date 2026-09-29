// Where tramecli's /api calls go: the local Trame app when it runs, else the hub,
// which serves the same core routes to a member's device token.
import { PORT_FILE, TLS_DIR } from "../app/config.ts";
import { getHubApi } from "../app/files.ts";
import { PROTOCOL_VERSION } from "../protocol/entities.ts";

export type Target = {
  base: string;
  hub: boolean;
  headers: Record<string, string>;
  client?: Deno.HttpClient;
};

const NOT_RUNNING =
  "Trame app is not running and no hub is configured (hubApi + hubApiToken in settings.json, or TRACKER_HUB_API + TRACKER_HUB_API_TOKEN). Start it with `just dev` or `just serve`.";

async function localBase(): Promise<string | null> {
  let port: number;
  try {
    port = JSON.parse(await Deno.readTextFile(PORT_FILE)).port;
  } catch {
    return null;
  }
  const base = `http://127.0.0.1:${port}`;
  const alive = await fetch(`${base}/api/status`, {
    signal: AbortSignal.timeout(800),
  })
    .then(async (r) => (await r.body?.cancel(), r.ok)).catch(() => false);
  return alive ? base : null;
}

// the hub's private CA, same file the app's sync trusts
function hubClient(): Deno.HttpClient | undefined {
  try {
    return Deno.createHttpClient({
      caCerts: [Deno.readTextFileSync(`${TLS_DIR}/ca.crt`)],
    });
  } catch {
    return undefined;
  }
}

let noted = false;

export async function resolveTarget(): Promise<Target> {
  const local = await localBase();
  if (local) return { base: local, hub: false, headers: {} };
  const hub = await getHubApi();
  if (!hub) throw new Error(NOT_RUNNING);
  if (!noted) {
    console.error(`note: Trame app not running — using the hub at ${hub.url}`);
  }
  noted = true;
  return {
    base: hub.url,
    hub: true,
    headers: {
      authorization: `Bearer ${hub.token}`,
      "x-trame-protocol": String(PROTOCOL_VERSION),
    },
    client: hubClient(),
  };
}

export function targetFetch(
  t: Target,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(t.headers)) headers.set(k, v);
  return fetch(`${t.base}${path}`, {
    ...init,
    headers,
    ...(t.client ? { client: t.client } : {}),
  });
}

export async function apiRequest(
  t: Target,
  path: string,
  init?: RequestInit,
  timeoutMs: number | null = 5000,
): Promise<unknown> {
  const signal = timeoutMs === null
    ? init?.signal
    : AbortSignal.timeout(timeoutMs);
  const res = await targetFetch(t, path, { ...init, signal }).catch(() => {
    throw new Error(
      t.hub
        ? `the hub at ${t.base} is not reachable`
        : "Trame app is not reachable (stale port file?). Start it with `just dev` or `just serve`.",
    );
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// the app's UI link for a query; the hub has no UI, so null there
export const appUrl = (t: Target, query: string): string | null =>
  t.hub ? null : `${t.base}/?${query}`;

export function appLink(t: Target, query: string): string {
  const url = appUrl(t, query);
  return url ? ` — ${url}` : "";
}
