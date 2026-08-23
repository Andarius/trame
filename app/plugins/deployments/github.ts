// GitHub: workflow runs paused on a protected environment. Two-step (N+1):
// runs?status=waiting, then pending_deployments per run — fine authenticated
// (5000 req/h), so callers must not invoke this without a token.
import type { Changelog, PendingDeployment } from "./mod.ts";

type Run = {
  id: number;
  display_title: string;
  head_branch: string;
  head_sha: string;
  html_url: string;
  updated_at: string;
  actor: { login: string } | null;
};

async function gh(path: string, token: string): Promise<unknown> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(
      `HTTP ${r.status}${
        r.status === 401 || r.status === 403 ? " — check token/permissions" : ""
      }`,
    );
  }
  return r.json();
}

export async function githubPending(
  repo: string,
  token: string,
): Promise<PendingDeployment[]> {
  const { workflow_runs: runs = [] } = await gh(
    `/repos/${repo}/actions/runs?status=waiting&per_page=50`,
    token,
  ) as { workflow_runs?: Run[] };
  const out: PendingDeployment[] = [];
  for (const run of runs) {
    const pending = await gh(
      `/repos/${repo}/actions/runs/${run.id}/pending_deployments`,
      token,
    ) as {
      environment: { id: number; name: string };
      current_user_can_approve?: boolean;
    }[];
    for (const p of pending) {
      out.push({
        source: "github",
        repo,
        environment: p.environment.name,
        ref: run.head_branch,
        sha: run.head_sha,
        title: run.display_title,
        requester: run.actor?.login ?? null,
        waitingSince: run.updated_at, // pending_deployments carries no timestamp
        url: run.html_url,
        action: p.current_user_can_approve === false ? null : {
          kind: "github-approve",
          repo,
          runId: run.id,
          environmentId: p.environment.id,
        },
        status: "waiting", // GitHub currently tracks approval gates only
      });
    }
  }
  return out;
}

// What's in this deploy: commits between the environment's last deployment and
// the pending head. Baseline = newest deployment record with a different sha
// (the pending run's own record is already there, in "waiting"); statuses are
// not checked — that would be another N+1 for a marginal edge case.
export async function githubChangelog(
  repo: string,
  environment: string,
  sha: string,
  token: string,
): Promise<Changelog> {
  const deps = await gh(
    `/repos/${repo}/deployments?environment=${
      encodeURIComponent(environment)
    }&per_page=20`,
    token,
  ) as { sha: string }[];
  const base = deps.find((d) => d.sha !== sha)?.sha;
  if (!base) {
    return { ok: false, error: "no previous deployment to compare against" };
  }
  const cmp = await gh(
    `/repos/${repo}/compare/${base}...${sha}?per_page=100`,
    token,
  ) as {
    html_url: string;
    commits: {
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: { name?: string; date?: string } | null;
      };
      author: { login: string } | null;
    }[];
  };
  return {
    ok: true,
    baseline: base.slice(0, 7),
    compareUrl: cmp.html_url,
    commits: cmp.commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      title: c.commit.message.split("\n")[0],
      author: c.author?.login ?? c.commit.author?.name ?? null,
      date: c.commit.author?.date ?? null,
      url: c.html_url,
    })).reverse(), // newest first, like the deployments list
  };
}
