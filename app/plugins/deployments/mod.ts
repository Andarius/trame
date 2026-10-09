// Deployments plugin: a stateless lens on GitHub/GitLab deployments waiting for
// approval. No PGlite, no sync — the forges own the state; a module-level cache
// (the sync-loop `lastSync` pattern) feeds /state and the nav badge.
import {
  DEPLOYMENTS_FIXTURE,
  DEPLOYMENTS_POLL_ACTIVE_MS,
  DEPLOYMENTS_POLL_IDLE_MS,
} from "../../config.ts";
import type { Plugin, PluginSettings } from "../types.ts";
import {
  getPluginSettings,
  isPluginEnabled,
  savePluginSettings,
} from "../settings.ts";
import {
  type AuthSource,
  cliInstalled,
  dropCliCache,
  githubAuth,
  gitlabAuth,
  glabApi,
  glabCliUser,
} from "./auth.ts";
import { spawnTerminal } from "../../terminal.ts";
import { githubChangelog, githubPending, githubShippedPrs } from "./github.ts";
import { APP_CTX } from "../../ctx.ts";
import {
  DEFAULT_RULES,
  logWaiting,
  matchCards,
  openCardsWithPrs,
  refNumbers,
  ruleFor,
  sanitizeRules,
  type ShippedCard,
  type ShipRule,
} from "./ships.ts";
import {
  gitlabActivePipeline,
  gitlabChangelog,
  gitlabPending,
  gitlabShippedMrs,
} from "./gitlab.ts";

// How to act on a pending deployment from the panel (null = deep link only).
export type ApproveAction =
  | { kind: "gitlab-play"; project: string; jobId: number }
  | { kind: "gitlab-approve"; project: string; deploymentId: number }
  | {
    kind: "github-approve";
    repo: string;
    runId: number;
    environmentId: number;
  };

// How to stop it: reject a gate, or cancel a running job. A GitLab manual job has none (ignore it instead).
export type CancelAction =
  | { kind: "github-reject"; repo: string; runId: number; environmentId: number }
  | { kind: "gitlab-reject"; project: string; deploymentId: number }
  | { kind: "gitlab-cancel"; project: string; jobId: number };

// waiting = needs approval/play; running = deploying now; failed = recently failed.
export type DeployStatus = "waiting" | "running" | "failed";

export type PendingDeployment = {
  source: "github" | "gitlab";
  repo: string;
  environment: string;
  ref: string;
  sha?: string | null; // head commit, when the forge exposes it — drives /changelog
  title: string;
  requester: string | null;
  waitingSince: string; // the relevant instant: waiting-since / started-at / failed-at
  url: string;
  action: ApproveAction | null;
  cancel?: CancelAction | null;
  status: DeployStatus;
  ignored?: boolean; // stamped from the settings slice at poll time
  ships?: ShippedCard[]; // open cards whose PRs this waiting release carries
};

export type ChangelogCommit = {
  sha: string;
  title: string;
  author: string | null;
  date: string | null;
  url: string | null;
};

export type Changelog =
  | {
    ok: true;
    baseline: string | null; // short sha the compare starts from (null in fixture mode)
    compareUrl: string | null;
    commits: ChangelogCommit[];
  }
  | { ok: false; error: string };

export type DeploymentsState = {
  configured: boolean;
  items: PendingDeployment[];
  polledAt: string | null;
  errors: { source: string; error: string }[];
  auth: { github: AuthSource; gitlab: AuthSource };
  // a watched GitLab pipeline is in flight → the poller is in fast mode
  activePipeline: boolean;
};

const ID = "deployments";

let state: DeploymentsState = {
  configured: false,
  items: [],
  polledAt: null,
  errors: [],
  auth: { github: "none", gitlab: "none" },
  activePipeline: false,
};
let pollRunning: Promise<DeploymentsState> | null = null;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string").map((s) => s.trim())
      .filter(Boolean)
    : [];

const baseUrlOf = (slice: PluginSettings): string =>
  (typeof slice.gitlabBaseUrl === "string" && slice.gitlabBaseUrl.trim()
    ? slice.gitlabBaseUrl.trim()
    : "https://gitlab.com").replace(/\/+$/, "");

// failures & things needing action first, then in-progress; oldest first within
const STATUS_RANK: Record<DeployStatus, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
};
const byWaiting = (items: PendingDeployment[]) =>
  items.sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.waitingSince.localeCompare(b.waitingSince)
  );

// Ignore identity: the deployment page + environment (same pair /approve uses
// to drop an acted-on item). A new pipeline gets a new URL, so it resurfaces.
const keyOf = (i: { url: string; environment: string }) =>
  `${i.url}\n${i.environment}`;

const markIgnored = (
  items: PendingDeployment[],
  slice: PluginSettings,
): PendingDeployment[] => {
  const keys = new Set(strList(slice.ignored));
  return items.map((i) => ({ ...i, ignored: keys.has(keyOf(i)) }));
};

async function pollOnce(): Promise<DeploymentsState> {
  if (DEPLOYMENTS_FIXTURE) {
    const fixture = JSON.parse(await Deno.readTextFile(DEPLOYMENTS_FIXTURE));
    const changelogs = (fixture.changelogs ?? {}) as Record<
      string,
      ChangelogCommit[]
    >;
    const fixtureSlice = await getPluginSettings(ID);
    const items = await withShips(
      ((fixture.items ?? []) as PendingDeployment[]).map((i) => ({
        ...i,
        status: i.status ?? "waiting",
      })),
      fixtureSlice,
      (i, rule) =>
        Promise.resolve(
          (changelogs[i.url] ?? []).map((c) =>
            refNumbers(c.title, rule.pattern)
          ),
        ),
    );
    return state = {
      configured: true,
      items: markIgnored(byWaiting(items), fixtureSlice),
      polledAt: new Date().toISOString(),
      errors: (fixture.errors ?? []) as DeploymentsState["errors"],
      auth: { github: "none", gitlab: "none" },
      activePipeline: false,
    };
  }
  const slice = await getPluginSettings(ID);
  const repos = strList(slice.githubRepos);
  const projects = strList(slice.gitlabProjects);
  const baseUrl = baseUrlOf(slice);
  const gh = repos.length
    ? await githubAuth(slice)
    : { token: "", source: "none" as const };
  const gl = projects.length
    ? await gitlabAuth(slice, baseUrl)
    : { token: "", source: "none" as const };

  const errors: DeploymentsState["errors"] = [];
  const jobs: Promise<PendingDeployment[]>[] = [];
  if (repos.length && !gh.token) {
    errors.push({
      source: "github",
      error: "no token — set a PAT or log in with gh",
    });
  } else {
    jobs.push(...repos.map((r) =>
      githubPending(r, gh.token).catch((e) => {
        errors.push({ source: r, error: String(e?.message ?? e) });
        return [];
      })
    ));
  }
  if (projects.length && gl.source === "none") {
    errors.push({
      source: "gitlab",
      error: "no token — set a PAT or log in with glab",
    });
  } else {
    jobs.push(
      ...projects.map((p) =>
        gitlabPending(p, baseUrl, gl).catch((e) => {
          errors.push({ source: p, error: String(e?.message ?? e) });
          return [];
        })
      ),
    );
  }
  // In flight? Only worth asking when GitLab auth resolved — one call/project.
  const pipelineChecks = projects.length && gl.source !== "none"
    ? projects.map((p) =>
      gitlabActivePipeline(p, baseUrl, gl).catch(() => false)
    )
    : [];

  const [itemLists, active] = await Promise.all([
    Promise.all(jobs),
    Promise.all(pipelineChecks),
  ]);
  const items = markIgnored(
    byWaiting(
      await withShips(itemLists.flat(), slice, (i, rule) => {
        const sha = i.sha ?? i.ref;
        if (i.source === "github") {
          return gh.token
            ? githubShippedPrs(
              i.repo,
              i.environment,
              sha,
              gh.token,
              rule.pattern,
            )
            : Promise.resolve(null);
        }
        return gl.source === "none" ? Promise.resolve(null) : gitlabShippedMrs(
          i.repo,
          baseUrl,
          gl,
          i.environment,
          sha,
          rule.pattern,
        );
      }),
    ),
    slice,
  );
  // Ignores for items the forges no longer report are spent — prune them, but
  // only on a clean poll (an erroring forge would otherwise wipe live ignores).
  if (errors.length === 0) {
    const present = new Set(items.map(keyOf));
    const stored = strList(slice.ignored);
    const kept = stored.filter((k) => present.has(k));
    if (kept.length !== stored.length) {
      await savePluginSettings(ID, { ignored: kept });
    }
  }
  return state = {
    configured: repos.length + projects.length > 0,
    items,
    polledAt: new Date().toISOString(),
    errors,
    auth: { github: gh.source, gitlab: gl.source },
    // fast-poll while a pipeline is in flight OR a deployment is running, so
    // success/failure and the elapsed time refresh within seconds.
    activePipeline: active.some(Boolean) ||
      items.some((i) => i.status === "running"),
  };
}

// `${repo}@${sha}@${pattern}` → PR/MR numbers per commit; a sha's compare range never changes.
const shippedPrs = new Map<string, number[][]>();

// Stamp each waiting release with the open cards it ships (per-repo rule), logging once on each card.
// `refsOf` resolves null when the forge has no auth: skipped, not cached.
async function withShips(
  items: PendingDeployment[],
  slice: PluginSettings,
  refsOf: (i: PendingDeployment, rule: ShipRule) => Promise<number[][] | null>,
): Promise<PendingDeployment[]> {
  const ruleOf = (i: PendingDeployment) =>
    ruleFor(slice.ships, i.repo, i.source);
  const isWaiting = (i: PendingDeployment) => {
    const envs = ruleOf(i).environments;
    return i.status === "waiting" &&
      (!envs.length || envs.includes(i.environment));
  };
  if (!items.some(isWaiting)) return items;
  const host = baseUrlOf(slice);
  const cards = await openCardsWithPrs(APP_CTX);
  const live = new Set<string>();
  const out: PendingDeployment[] = [];
  for (const i of items) {
    if (!isWaiting(i)) {
      out.push(i);
      continue;
    }
    const rule = ruleOf(i);
    const key = `${i.repo}@${i.sha ?? i.url}@${rule.pattern}`;
    live.add(key);
    let prs = shippedPrs.get(key);
    if (!prs) {
      try {
        const got = await refsOf(i, rule);
        if (got) shippedPrs.set(key, prs = got);
      } catch (e) {
        console.error(e); // retried next poll
      }
    }
    if (!prs) {
      out.push(i);
      continue;
    }
    const ships = matchCards(i.source, host, i.repo, prs, cards, rule.backport);
    for (const c of ships) {
      await logWaiting(
        APP_CTX,
        c.card_id,
        `release "${i.title}" waiting on ${i.environment} — ${i.url}`,
      );
    }
    out.push(ships.length ? { ...i, ships } : i);
  }
  for (const k of shippedPrs.keys()) if (!live.has(k)) shippedPrs.delete(k);
  return out;
}

// Coalesce concurrent polls (refresh clicked while the interval tick runs).
function poll(): Promise<DeploymentsState> {
  pollRunning ??= pollOnce().finally(() => pollRunning = null);
  return pollRunning;
}

// Probe a forge with (possibly unsaved) form values — nothing is persisted.
// Mirrors the hub's /api/hub/test pattern.
async function testForge(body: Record<string, unknown>): Promise<
  { ok: boolean; user?: string; source?: string; error?: string }
> {
  if (DEPLOYMENTS_FIXTURE) {
    return { ok: true, user: "fixture", source: "none" }; // offline in tests/demos
  }
  const stored = await getPluginSettings(ID);
  const slice: PluginSettings = { ...stored };
  if (typeof body.githubToken === "string" && body.githubToken.trim()) {
    slice.githubToken = body.githubToken.trim();
  }
  const glToken = typeof body.gitlabToken === "string"
    ? body.gitlabToken.trim()
    : "";
  if (glToken) slice.gitlabToken = glToken;
  let glBaseOverridden = false;
  if (typeof body.gitlabBaseUrl === "string" && body.gitlabBaseUrl.trim()) {
    const next = body.gitlabBaseUrl.trim();
    const cur = typeof stored.gitlabBaseUrl === "string"
      ? stored.gitlabBaseUrl.trim()
      : "";
    glBaseOverridden = next !== cur;
    slice.gitlabBaseUrl = next;
  }
  // Never send a credential the caller didn't supply to a host the caller named:
  // drop the saved PAT, and (via ambient:false below) GITLAB_TOKEN/CLI too.
  if (glBaseOverridden && !glToken) slice.gitlabToken = "";
  try {
    if (body.forge === "github") {
      const auth = await githubAuth(slice);
      if (!auth.token) {
        return {
          ok: false,
          source: "none",
          error: "no token found (PAT, GITHUB_TOKEN or gh cli)",
        };
      }
      const r = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${auth.token}`,
          accept: "application/vnd.github+json",
        },
      });
      if (!r.ok) {
        await r.body?.cancel();
        return { ok: false, source: auth.source, error: `HTTP ${r.status}` };
      }
      const u = await r.json() as { login?: string };
      return { ok: true, user: u.login, source: auth.source };
    }
    const base = baseUrlOf(slice);
    const auth = await gitlabAuth(slice, base, { ambient: !glBaseOverridden });
    if (auth.source === "none") {
      return {
        ok: false,
        source: "none",
        error: "no token found (PAT, GITLAB_TOKEN or glab cli)",
      };
    }
    if (auth.source === "cli") {
      const user = await glabCliUser(new URL(base).hostname);
      return user
        ? { ok: true, user, source: "cli" }
        : { ok: false, source: "cli", error: "glab api failed" };
    }
    const r = await fetch(`${base}/api/v4/user`, {
      headers: { "private-token": auth.token },
    });
    if (!r.ok) {
      await r.body?.cancel();
      return { ok: false, source: auth.source, error: `HTTP ${r.status}` };
    }
    const u = await r.json() as { username?: string };
    return { ok: true, user: u.username, source: auth.source };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// short, useful failure text — forge errors carry a JSON message
async function httpError(r: Response): Promise<string> {
  const text = await r.text().catch(() => "");
  let msg = "";
  try {
    const j = JSON.parse(text) as { message?: unknown };
    if (typeof j.message === "string") msg = j.message;
  } catch { /* not json */ }
  return `HTTP ${r.status}${msg ? ` — ${msg}` : ""}`;
}

// Act on a deployment: approve/reject the GitHub gate, play the GitLab manual job,
// approve/reject the GitLab deployment, or cancel a running job. Guarded by the watch list.
async function approveOne(
  raw: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const a = (raw ?? {}) as Record<string, unknown>;
  const slice = await getPluginSettings(ID);
  try {
    if (a.kind === "github-approve" || a.kind === "github-reject") {
      const repo = typeof a.repo === "string" ? a.repo : "";
      if (!strList(slice.githubRepos).includes(repo)) {
        return { ok: false, error: "repo not in watch list" };
      }
      if (typeof a.runId !== "number" || typeof a.environmentId !== "number") {
        return { ok: false, error: "bad action" };
      }
      const gh = await githubAuth(slice);
      if (!gh.token) return { ok: false, error: "no GitHub token" };
      const r = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${a.runId}/pending_deployments`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${gh.token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            environment_ids: [a.environmentId],
            state: a.kind === "github-approve" ? "approved" : "rejected",
            comment: `${a.kind === "github-approve" ? "approved" : "rejected"} from Trame`,
          }),
        },
      );
      if (!r.ok) return { ok: false, error: await httpError(r) };
      await r.body?.cancel();
      return { ok: true };
    }
    if (
      a.kind === "gitlab-play" || a.kind === "gitlab-approve" ||
      a.kind === "gitlab-reject" || a.kind === "gitlab-cancel"
    ) {
      const project = typeof a.project === "string" ? a.project : "";
      if (!strList(slice.gitlabProjects).includes(project)) {
        return { ok: false, error: "project not in watch list" };
      }
      const job = a.kind === "gitlab-play" || a.kind === "gitlab-cancel";
      const id = job ? a.jobId : a.deploymentId;
      if (typeof id !== "number") return { ok: false, error: "bad action" };
      const baseUrl = baseUrlOf(slice);
      const gl = await gitlabAuth(slice, baseUrl);
      if (gl.source === "none") return { ok: false, error: "no GitLab token" };
      const proj = encodeURIComponent(project);
      const path = job
        ? `projects/${proj}/jobs/${id}/${a.kind === "gitlab-play" ? "play" : "cancel"}`
        : `projects/${proj}/deployments/${id}/approval`;
      const fields = job
        ? undefined
        : { status: a.kind === "gitlab-approve" ? "approved" : "rejected" };
      if (gl.source === "cli") {
        await glabApi(new URL(baseUrl).hostname, path, {
          method: "POST",
          fields,
        });
      } else {
        const r = await fetch(`${baseUrl}/api/v4/${path}`, {
          method: "POST",
          headers: {
            "private-token": gl.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(fields ?? {}),
        });
        if (!r.ok) return { ok: false, error: await httpError(r) };
        await r.body?.cancel();
      }
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// Per-forge CLI/auth picture for the settings UI: is the CLI there, and which
// chain link currently answers? dropCliCache() first so a login done since the
// last poll is seen immediately.
async function authStatus(gitlabBaseUrl?: string | null): Promise<
  Record<
    "github" | "gitlab",
    { cli: boolean; source: AuthSource; loginCommand: string | null }
  >
> {
  dropCliCache();
  const slice = { ...(await getPluginSettings(ID)) };
  if (gitlabBaseUrl?.trim()) slice.gitlabBaseUrl = gitlabBaseUrl.trim(); // unsaved form value wins
  const glHost = new URL(baseUrlOf(slice)).hostname;
  const [ghCli, glCli, gh, gl] = await Promise.all([
    cliInstalled("gh"),
    cliInstalled("glab"),
    githubAuth(slice),
    gitlabAuth(slice, baseUrlOf(slice)),
  ]);
  return {
    github: {
      cli: ghCli,
      source: gh.source,
      loginCommand: loginCommand("github", "github.com"),
    },
    gitlab: {
      cli: glCli,
      source: gl.source,
      loginCommand: loginCommand("gitlab", glHost),
    },
  };
}

// The official CLI device-flow login command per forge — also returned to the
// UI so the user can copy/run it themselves instead of the spawned terminal.
function loginCommand(forge: string, host: string): string | null {
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return null; // shell-safe hostnames only
  return forge === "github"
    ? "gh auth login --hostname github.com --git-protocol https --web"
    : `glab auth login --hostname ${host}`;
}

// Kick off the login in a real terminal — the app never sees or stores the
// credential; `gh auth token` / `glab auth status` picks it up afterwards.
function spawnLogin(
  forge: string,
  host: string,
): { launched: boolean; command: string | null } {
  const command = loginCommand(forge, host);
  if (!command) return { launched: false, command: null };
  const home = Deno.env.get("HOME") ?? ".";
  return { launched: spawnTerminal(home, command), command };
}

// Idle poll cadence is user-configurable (seconds), clamped to a sane range;
// the env default (DEPLOYMENTS_POLL_IDLE_MS) is the fallback when unset.
const DEFAULT_IDLE_SECONDS = Math.round(DEPLOYMENTS_POLL_IDLE_MS / 1000);
const clampIdle = (n: number) => Math.min(3600, Math.max(15, Math.round(n)));
async function idlePollMs(): Promise<number> {
  const n = Number((await getPluginSettings(ID)).pollIdleSeconds);
  return (Number.isFinite(n) && n > 0 ? clampIdle(n) : DEFAULT_IDLE_SECONDS) *
    1000;
}

const deployments: Plugin = {
  id: ID,
  label: "Deployments",
  glyph: "⇈",
  description: "GitHub & GitLab releases waiting for approval, in the sidebar.",
  // settings-UI routes, usable before the plugin is enabled
  ungatedRoutes: ["/test", "/auth-status", "/login"],

  badge: () => state.items.filter((i) => !i.ignored).length || null,

  // Enabled from a cold start, the loop below is up to one idle interval (5 min) away
  // — fill the panel now instead of leaving it on "Loading…".
  onEnabled() {
    poll().catch(console.error);
  },

  start() {
    // Self-rescheduling loop: idle cadence, but 10s while a pipeline is in
    // flight so the approval gate is caught within seconds of appearing.
    const loop = async () => {
      let delay = await idlePollMs();
      if (await isPluginEnabled(ID)) { // toggle applies next tick
        const s = await poll().catch((e) => {
          console.error(e);
          return null;
        });
        delay = s?.activePipeline
          ? DEPLOYMENTS_POLL_ACTIVE_MS
          : await idlePollMs();
      }
      setTimeout(loop, delay);
    };
    loop();
  },

  async routes(req, subPath, url) {
    if (subPath === "/state") return json(state);
    if (subPath === "/refresh" && req.method === "POST") {
      return json(await poll());
    }
    // /cancel posts the item's `cancel` action through the same path
    if ((subPath === "/approve" || subPath === "/cancel") && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const drop = () =>
        // remove the acted-on item now — the forge lags a beat
        state = {
          ...state,
          items: state.items.filter((i) =>
            !(i.url === body.url && i.environment === body.environment)
          ),
        };
      if (DEPLOYMENTS_FIXTURE) return json({ ok: true, state: drop() });
      const res = await approveOne(body.action);
      if (!res.ok) return json(res, 502);
      // Optimistic: reflect success immediately, then reconcile once the forge
      // catches up (re-adds if it genuinely still needs another approver).
      const out = json({ ok: true, state: drop() });
      setTimeout(() => poll().catch(console.error), 4000);
      return out;
    }
    if (subPath === "/ignore" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const itemUrl = typeof body.url === "string" ? body.url : "";
      const environment = typeof body.environment === "string"
        ? body.environment
        : "";
      if (!itemUrl || !environment) {
        return json({ ok: false, error: "bad request" }, 400);
      }
      const key = keyOf({ url: itemUrl, environment });
      const ignored = body.ignored !== false;
      if (ignored && !state.items.some((i) => keyOf(i) === key)) {
        return json({ ok: false, error: "unknown deployment" }, 404);
      }
      const stored = new Set(strList((await getPluginSettings(ID)).ignored));
      if (ignored) stored.add(key);
      else stored.delete(key);
      await savePluginSettings(ID, { ignored: [...stored] });
      state = {
        ...state,
        items: state.items.map((i) => keyOf(i) === key ? { ...i, ignored } : i),
      };
      return json({ ok: true, state });
    }
    if (subPath === "/changelog" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const itemUrl = typeof body.url === "string" ? body.url : "";
      const environment = typeof body.environment === "string"
        ? body.environment
        : "";
      if (DEPLOYMENTS_FIXTURE) {
        const fixture = JSON.parse(
          await Deno.readTextFile(DEPLOYMENTS_FIXTURE),
        );
        const commits = (fixture.changelogs ?? {})[itemUrl] as
          | ChangelogCommit[]
          | undefined;
        return json(
          commits
            ? { ok: true, baseline: null, compareUrl: null, commits }
            : { ok: false, error: "no changelog available" },
        );
      }
      const item = state.items.find((i) =>
        i.url === itemUrl && i.environment === environment
      );
      if (!item) return json({ ok: false, error: "unknown deployment" }, 404);
      const slice = await getPluginSettings(ID);
      try {
        if (item.source === "github") {
          const gh = await githubAuth(slice);
          if (!gh.token) {
            return json({ ok: false, error: "no GitHub token" }, 502);
          }
          return json(
            await githubChangelog(
              item.repo,
              item.environment,
              item.sha ?? item.ref,
              gh.token,
            ),
          );
        }
        const baseUrl = baseUrlOf(slice);
        const gl = await gitlabAuth(slice, baseUrl);
        if (gl.source === "none") {
          return json({ ok: false, error: "no GitLab token" }, 502);
        }
        return json(
          await gitlabChangelog(
            item.repo,
            baseUrl,
            gl,
            item.environment,
            item.sha ?? item.ref,
          ),
        );
      } catch (e) {
        return json(
          { ok: false, error: String((e as Error)?.message ?? e) },
          502,
        );
      }
    }
    if (subPath === "/test" && req.method === "POST") {
      return json(await testForge(await req.json().catch(() => ({}))));
    }
    if (subPath === "/auth-status") {
      return json(await authStatus(url.searchParams.get("gitlabBaseUrl")));
    }
    if (subPath === "/login" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      // unsaved base URL from the form wins, like /test
      const slice = { ...(await getPluginSettings(ID)) };
      if (typeof body.gitlabBaseUrl === "string" && body.gitlabBaseUrl.trim()) {
        slice.gitlabBaseUrl = body.gitlabBaseUrl.trim();
      }
      const host = body.forge === "github"
        ? "github.com"
        : new URL(baseUrlOf(slice)).hostname;
      return json(
        spawnLogin(body.forge === "github" ? "github" : "gitlab", host),
      );
    }
    return null;
  },

  sanitizeSettings(raw, current) {
    const patch: PluginSettings = {};
    if ("githubRepos" in raw) patch.githubRepos = strList(raw.githubRepos);
    if ("gitlabProjects" in raw) {
      patch.gitlabProjects = strList(raw.gitlabProjects);
    }
    if (typeof raw.gitlabBaseUrl === "string") {
      patch.gitlabBaseUrl = raw.gitlabBaseUrl.trim();
    }
    if ("ships" in raw) {
      const watched = [
        ...strList(patch.githubRepos ?? current.githubRepos),
        ...strList(patch.gitlabProjects ?? current.gitlabProjects),
      ];
      patch.ships = sanitizeRules(raw.ships, watched);
    }
    if ("pollIdleSeconds" in raw) {
      const n = Number(raw.pollIdleSeconds);
      if (Number.isFinite(n) && n > 0) patch.pollIdleSeconds = clampIdle(n);
    }
    // blank token = keep the stored one (the UI never gets it back); explicit clear deletes.
    // GitHub's host is fixed (api.github.com), so its token needs no host binding.
    if (typeof raw.githubToken === "string" && raw.githubToken.trim()) {
      patch.githubToken = raw.githubToken.trim();
    } else if (raw.clearGithubToken === true) patch.githubToken = "";
    else if (typeof current.githubToken === "string") {
      patch.githubToken = current.githubToken;
    }
    // The GitLab token is BOUND to its base URL: never carry a stored PAT over to a
    // different host. Changing the host without re-supplying the token clears it, so
    // a CSRF-swapped base URL can't make the poller leak the saved token.
    const curBase = typeof current.gitlabBaseUrl === "string"
      ? current.gitlabBaseUrl.trim()
      : "";
    const hostChanged = typeof patch.gitlabBaseUrl === "string" &&
      patch.gitlabBaseUrl !== curBase;
    if (typeof raw.gitlabToken === "string" && raw.gitlabToken.trim()) {
      patch.gitlabToken = raw.gitlabToken.trim();
    } else if (raw.clearGitlabToken === true || hostChanged) {
      patch.gitlabToken = "";
    } else if (typeof current.gitlabToken === "string") {
      patch.gitlabToken = current.gitlabToken;
    }
    return patch;
  },

  settingsView(slice) {
    return {
      githubRepos: strList(slice.githubRepos),
      gitlabProjects: strList(slice.gitlabProjects),
      gitlabBaseUrl: typeof slice.gitlabBaseUrl === "string"
        ? slice.gitlabBaseUrl
        : "",
      githubHasToken: Boolean(
        typeof slice.githubToken === "string" && slice.githubToken,
      ),
      gitlabHasToken: Boolean(
        typeof slice.gitlabToken === "string" && slice.gitlabToken,
      ),
      pollIdleSeconds: typeof slice.pollIdleSeconds === "number"
        ? slice.pollIdleSeconds
        : DEFAULT_IDLE_SECONDS,
      auth: state.auth, // which chain link answered on the last poll
      ships: sanitizeRules(slice.ships, [
        ...strList(slice.githubRepos),
        ...strList(slice.gitlabProjects),
      ]),
      shipDefaults: DEFAULT_RULES,
    };
  },
};

export default deployments;
