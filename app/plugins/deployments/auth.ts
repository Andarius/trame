// Forge auth: settings PAT → env var → CLI. An explicitly configured token
// must not be shadowed by whatever account the CLI happens to be on (same
// precedence as the hub settings in files.ts). CLI lookup is best-effort — a
// GUI-launched app may not even have gh/glab on PATH.
//
// GitHub CLI: `gh auth token` returns a long-lived token — safe to extract.
// GitLab CLI: glab's stored OAuth token can be EXPIRED while `auth status`
// still says "Logged in" (glab only refreshes it on real API calls), so we
// never extract it — GitLab CLI mode shells out to `glab api`, which signs
// and refreshes the request itself.
import type { PluginSettings } from "../types.ts";

export type AuthSource = "settings" | "env" | "cli" | "none";
// cli source carries no token for GitLab — callers go through glabApi() instead
export type Auth = { token: string; source: AuthSource };

const CACHE_MS = 10 * 60_000; // CLI calls are slow; auth state doesn't churn
const ghTokenCache = { at: 0, token: "" };
const glabUserCache = new Map<string, { at: number; user: string | null }>();

// Forget cached CLI lookups — after a `gh/glab auth login` the settings UI
// must see the new state immediately.
export function dropCliCache(): void {
  ghTokenCache.at = 0;
  glabUserCache.clear();
}

// Is the CLI on PATH at all? (distinct from "installed but not logged in")
export async function cliInstalled(cmd: "gh" | "glab"): Promise<boolean> {
  try {
    const out = await new Deno.Command(cmd, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false; // not on PATH
  }
}

async function ghCliToken(): Promise<string> {
  if (Date.now() - ghTokenCache.at < CACHE_MS) return ghTokenCache.token;
  let token = "";
  try {
    const out = await new Deno.Command("gh", {
      args: ["auth", "token"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (out.success) token = new TextDecoder().decode(out.stdout).trim();
  } catch { /* gh missing */ }
  ghTokenCache.at = Date.now();
  ghTokenCache.token = token;
  return token;
}

// Run a GitLab API call through glab (handles auth + OAuth refresh + host).
// `path` is relative to /api/v4, query string allowed.
export async function glabApi<T>(
  host: string,
  path: string,
  opts?: { method?: string; fields?: Record<string, string> },
): Promise<T> {
  const args = ["api", path, "--hostname", host];
  if (opts?.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts?.fields ?? {})) {
    args.push("-f", `${k}=${v}`);
  }
  const out = await new Deno.Command("glab", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(stderr.split("\n").pop() || "glab api failed");
  }
  const text = new TextDecoder().decode(out.stdout).trim();
  return (text ? JSON.parse(text) : undefined) as T;
}

// "Is glab usable for this host?" — probe with a real API call (the only
// signal that survives glab's expired-but-logged-in state). Cached 10 min.
export async function glabCliUser(host: string): Promise<string | null> {
  const hit = glabUserCache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  let user: string | null = null;
  try {
    const u = await glabApi<{ username?: string }>(host, "user");
    user = u.username ?? null;
  } catch { /* not installed / not logged in / host unreachable */ }
  glabUserCache.set(host, { at: Date.now(), user });
  return user;
}

export async function githubAuth(slice: PluginSettings): Promise<Auth> {
  const pat = typeof slice.githubToken === "string"
    ? slice.githubToken.trim()
    : "";
  if (pat) return { token: pat, source: "settings" };
  const env = Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN") ?? "";
  if (env) return { token: env, source: "env" };
  const t = await ghCliToken();
  return t ? { token: t, source: "cli" } : { token: "", source: "none" };
}

// ambient:false = base URL came from the request — GITLAB_TOKEN/CLI are bound to the
// saved host, so a caller-supplied host must carry its own token.
export async function gitlabAuth(
  slice: PluginSettings,
  baseUrl: string,
  opts?: { ambient?: boolean },
): Promise<Auth> {
  const pat = typeof slice.gitlabToken === "string"
    ? slice.gitlabToken.trim()
    : "";
  if (pat) return { token: pat, source: "settings" };
  if (opts?.ambient === false) return { token: "", source: "none" };
  const env = Deno.env.get("GITLAB_TOKEN") ?? "";
  if (env) return { token: env, source: "env" };
  const host = new URL(baseUrl).hostname;
  const user = await glabCliUser(host);
  return user ? { token: "", source: "cli" } : { token: "", source: "none" };
}
