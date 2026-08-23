// GitLab: a release is "waiting" when an environment's MOST RECENT deployment
// is blocked (approval gate — also how Free tier marks un-played `when: manual`
// deploy jobs) or created with a manual deployable. Older blocked deployments
// are superseded noise (e.g. v1.69 still "blocked" months after v1.70 shipped),
// so we take one unfiltered newest-first page and keep the head of each env.
// CLI mode goes through `glab api` (it signs + refreshes OAuth itself — glab's
// stored token can be expired even while `auth status` says logged in).
import { type Auth, glabApi } from "./auth.ts";
import type { Changelog, PendingDeployment } from "./mod.ts";

type Deployment = {
  id: number;
  ref: string;
  sha: string;
  created_at: string;
  updated_at?: string;
  status: string;
  user: { username: string } | null;
  environment: { id: number; name: string };
  deployable:
    | {
      id?: number;
      name?: string;
      status?: string;
      web_url?: string;
      pipeline?: { web_url?: string };
    }
    | null;
};

// One GET against /api/v4 — via `glab api` in CLI mode (it signs + refreshes),
// otherwise a direct token'd fetch. `path` is relative to /api/v4.
async function gitlabGet<T>(
  baseUrl: string,
  auth: Auth,
  path: string,
): Promise<T> {
  if (auth.source === "cli") {
    return glabApi<T>(new URL(baseUrl).hostname, path);
  }
  const r = await fetch(`${baseUrl}/api/v4/${path}`, {
    headers: { "private-token": auth.token },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(
      `HTTP ${r.status}${
        r.status === 401 || r.status === 403 ? " — check token/permissions" : ""
      }`,
    );
  }
  return r.json() as Promise<T>;
}

// A recently-failed deployment is worth surfacing; older ones are just history.
const FAILED_WINDOW_MS = 3 * 60 * 60_000; // 3h

// A pipeline heading toward a deploy — not yet finished, so the gate hasn't
// appeared. `manual`/`blocked` mean it reached the gate (already in `items`).
const IN_FLIGHT = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
]);

// default_branch essentially never changes mid-session; cache per project.
const defaultBranchCache = new Map<string, string>();

async function defaultBranch(
  project: string,
  baseUrl: string,
  auth: Auth,
): Promise<string | null> {
  const key = `${baseUrl}::${project}`;
  const hit = defaultBranchCache.get(key);
  if (hit) return hit;
  const info = await gitlabGet<{ default_branch?: string }>(
    baseUrl,
    auth,
    `projects/${encodeURIComponent(project)}`,
  );
  const branch = info.default_branch ?? null;
  if (branch) defaultBranchCache.set(key, branch);
  return branch;
}

// Is the latest pipeline on the default branch still in flight? Drives the
// fast-poll window — one API call (plus a cached default_branch lookup).
export async function gitlabActivePipeline(
  project: string,
  baseUrl: string,
  auth: Auth,
): Promise<boolean> {
  const branch = await defaultBranch(project, baseUrl, auth);
  if (!branch) return false;
  const pipelines = await gitlabGet<{ status: string }[]>(
    baseUrl,
    auth,
    `projects/${encodeURIComponent(project)}/pipelines?ref=${
      encodeURIComponent(branch)
    }&per_page=1&order_by=updated_at&sort=desc`,
  );
  return pipelines[0] ? IN_FLIGHT.has(pipelines[0].status) : false;
}

export async function gitlabPending(
  project: string, // "group/name" path
  baseUrl: string,
  auth: Auth,
): Promise<PendingDeployment[]> {
  const deployments = await gitlabGet<Deployment[]>(
    baseUrl,
    auth,
    `projects/${
      encodeURIComponent(project)
    }/deployments?per_page=50&order_by=created_at&sort=desc`,
  );

  const seen = new Set<string>();
  const out: PendingDeployment[] = [];
  for (const d of deployments) { // newest first
    const env = d.environment.name;
    if (seen.has(env)) continue;
    seen.add(env); // only the head of each environment counts

    const manual = d.deployable?.status === "manual" && d.deployable.id;
    let status: PendingDeployment["status"];
    let action: PendingDeployment["action"] = null;
    if (manual && (d.status === "blocked" || d.status === "created")) {
      status = "waiting"; // un-played manual job → play it
      action = { kind: "gitlab-play", project, jobId: d.deployable!.id! };
    } else if (d.status === "blocked") {
      status = "waiting"; // Premium approval gate → approve it
      action = { kind: "gitlab-approve", project, deploymentId: d.id };
    } else if (d.status === "running" || d.status === "created") {
      status = "running"; // approved/played and deploying now
    } else if (d.status === "failed") {
      status = "failed";
    } else {
      continue; // success / canceled / skipped — nothing to show
    }

    const since = status === "failed"
      ? (d.updated_at ?? d.created_at)
      : d.created_at;
    // stale failures are history, not something to act on — only surface recent ones
    if (
      status === "failed" && Date.now() - Date.parse(since) > FAILED_WINDOW_MS
    ) {
      continue;
    }
    out.push({
      source: "gitlab",
      repo: project,
      environment: env,
      ref: d.ref,
      sha: d.sha,
      title: d.deployable?.name || `deploy #${d.id}`,
      requester: d.user?.username ?? null,
      waitingSince: since,
      // the job page carries the ▶ play / approve / logs; env page as fallback
      url: d.deployable?.web_url ??
        (d.environment.id
          ? `${baseUrl}/${project}/-/environments/${d.environment.id}`
          : `${baseUrl}/${project}`),
      action,
      status,
    });
  }
  return out;
}

// What's in this deploy: commits between the environment's last successful
// deployment and the pending sha, via /repository/compare.
export async function gitlabChangelog(
  project: string,
  baseUrl: string,
  auth: Auth,
  environment: string,
  sha: string,
): Promise<Changelog> {
  const proj = encodeURIComponent(project);
  const prev = await gitlabGet<{ sha: string }[]>(
    baseUrl,
    auth,
    `projects/${proj}/deployments?environment=${
      encodeURIComponent(environment)
    }&status=success&order_by=created_at&sort=desc&per_page=1`,
  );
  const base = prev[0]?.sha;
  if (!base) {
    return {
      ok: false,
      error: "no previous successful deployment to compare against",
    };
  }
  const cmp = await gitlabGet<{
    commits: {
      id: string;
      short_id: string;
      title: string;
      author_name: string | null;
      created_at: string;
    }[];
  }>(
    baseUrl,
    auth,
    `projects/${proj}/repository/compare?from=${base}&to=${
      encodeURIComponent(sha)
    }`,
  );
  return {
    ok: true,
    baseline: base.slice(0, 8),
    compareUrl: `${baseUrl}/${project}/-/compare/${base}...${sha}`,
    commits: cmp.commits.map((c) => ({
      sha: c.short_id,
      title: c.title,
      author: c.author_name,
      date: c.created_at,
      url: `${baseUrl}/${project}/-/commit/${c.id}`,
    })).reverse(), // compare is oldest-first; show newest first
  };
}
