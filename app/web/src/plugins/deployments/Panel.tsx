// Deployments plugin panel: GitHub/GitLab deployments waiting for approval,
// grouped under one tab per org/group. The backend poller owns freshness;
// the deploy button approves/plays via /approve (two clicks — confirm step),
// the row deep-links to the forge as before.
import { useEffect, useMemo, useState } from "react";
import { openInBrowser } from "../../api";
import { timeAgo } from "../../ui";

type ApproveAction =
  | { kind: "gitlab-play"; project: string; jobId: number }
  | { kind: "gitlab-approve"; project: string; deploymentId: number }
  | {
    kind: "github-approve";
    repo: string;
    runId: number;
    environmentId: number;
  };

type DeployStatus = "waiting" | "running" | "failed";
type PendingDeployment = {
  source: "github" | "gitlab";
  repo: string;
  environment: string;
  ref: string;
  title: string;
  requester: string | null;
  waitingSince: string;
  url: string;
  action: ApproveAction | null;
  status: DeployStatus;
};
export type DeploymentsState = {
  configured: boolean;
  items: PendingDeployment[];
  polledAt: string | null;
  errors: { source: string; error: string }[];
  auth: { github: string; gitlab: string };
  activePipeline: boolean;
};

const getState = () =>
  fetch("/api/plugins/deployments/state").then((r) =>
    r.json() as Promise<DeploymentsState>
  );
const refreshState = () =>
  fetch("/api/plugins/deployments/refresh", { method: "POST" })
    .then((r) => r.json() as Promise<DeploymentsState>);

const orgOf = (repo: string) => repo.split("/")[0];

// hold age → urgency color (copper accent past a day, blocked past two)
function ageColor(waitingSince: string): string {
  const h = (Date.now() - new Date(waitingSince).getTime()) / 3_600_000;
  return h >= 48 ? "text-blocked" : h >= 24 ? "text-paused" : "text-ink-muted";
}

// elapsed since a start instant, compact: "3m", "1h07"
function elapsed(since: string): string {
  const m = Math.max(0, (Date.now() - new Date(since).getTime()) / 60_000);
  if (m < 60) return `${m | 0}m`;
  return `${(m / 60) | 0}h${((m % 60) | 0).toString().padStart(2, "0")}`;
}

// Stable, distinct color per environment name. Production reads red (the risky
// one), staging-like envs amber; everything else hashes into a fixed palette so
// each env keeps a consistent hue across refreshes.
const ENV_PALETTE = [
  "#7a9ee7",
  "#b590e7",
  "#c98a63",
  "#7bd88f",
  "#5fb3c7",
  "#d98ec0",
];
function envColor(env: string): string {
  const e = env.toLowerCase();
  if (/prod(uction)?\b|\bprd\b|\blive\b/.test(e)) return "#e06c75";
  if (/stag|preprod|pre-prod|uat|canary|qa\b/.test(e)) return "#e3c567";
  let h = 0;
  for (let i = 0; i < env.length; i++) h = (h * 31 + env.charCodeAt(i)) >>> 0;
  return ENV_PALETTE[h % ENV_PALETTE.length];
}

// inline SVG, not the Unicode gear — ⚙ renders as a color emoji / tofu in the webviews
function GearIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function SourceChip({ source }: { source: "github" | "gitlab" }) {
  return (
    <span className="shrink-0 rounded border border-line bg-panel px-[5px] py-0.5 text-[9px] font-semibold tracking-[0.5px] text-ink-muted">
      {source === "github" ? "GH" : "GL"}
    </span>
  );
}

export function DeploymentsPanel(
  { onOpenSettings }: { onOpenSettings: () => void },
) {
  const [state, setState] = useState<DeploymentsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState<string | null>(null); // null = All
  const [confirming, setConfirming] = useState<string | null>(null); // item key
  const [deploying, setDeploying] = useState<string | null>(null);
  const [deployErr, setDeployErr] = useState<Record<string, string>>({});

  // Read the cached state on a cadence that matches the backend: quick while a
  // pipeline is in flight, relaxed otherwise.
  const active = state?.activePipeline ?? false;
  useEffect(() => {
    const load = () => getState().then(setState).catch(() => {});
    load();
    const t = setInterval(load, active ? 10_000 : 30_000);
    return () => clearInterval(t);
  }, [active]);

  const refresh = () => {
    if (busy) return;
    setBusy(true);
    refreshState().then(setState).catch(() => {}).finally(() => setBusy(false));
  };

  const deploy = (d: PendingDeployment, key: string) => {
    setConfirming(null);
    setDeploying(key);
    setDeployErr(({ [key]: _drop, ...rest }) => rest);
    fetch("/api/plugins/deployments/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: d.action,
        url: d.url,
        environment: d.environment,
      }),
    })
      .then((r) => r.json())
      .then((r: { ok: boolean; state?: DeploymentsState; error?: string }) => {
        if (r.ok && r.state) setState(r.state);
        else setDeployErr((e) => ({ ...e, [key]: r.error ?? "failed" }));
      })
      .catch(() => setDeployErr((e) => ({ ...e, [key]: "request failed" })))
      .finally(() => setDeploying(null));
  };

  // org → tracked-deployment count, biggest first (tab order stays meaningful)
  const orgs = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of state?.items ?? []) {
      m.set(orgOf(d.repo), (m.get(orgOf(d.repo)) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    );
  }, [state?.items]);

  // Before the first poll completes a fresh instance reports configured:false —
  // that's "still loading", not "no repos". Only trust it once polledAt is set.
  if (!state || (!state.configured && !state.polledAt)) {
    return <p className="p-6 text-ink-muted">Loading…</p>;
  }

  if (!state.configured) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="m-0 text-[13px] text-ink-muted">
          No repositories watched yet. Add the GitHub repos and GitLab projects
          whose deployments wait for approval.
        </p>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
        >
          Open plugin settings
        </button>
      </div>
    );
  }

  const shown = org
    ? state.items.filter((d) => orgOf(d.repo) === org)
    : state.items;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="text-[11px] text-ink-muted/70">
          {state.polledAt
            ? `polled ${timeAgo(state.polledAt)}`
            : "not polled yet"}
        </span>
        {state.activePipeline && (
          <span
            title="a pipeline is running on the default branch — checking every 10s"
            className="rounded-full border border-copper/40 px-2 py-0.5 text-[10.5px] text-copper"
          >
            ● pipeline running
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Deployments settings"
          className="flex items-center rounded-md border border-chipline px-1.5 py-1 text-ink-muted hover:text-ink-soft"
        >
          <GearIcon />
        </button>
      </div>
      {state.errors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2.5">
          {state.errors.map((e) => (
            <span
              key={e.source + e.error}
              title={e.error}
              className="max-w-[420px] truncate rounded-md border border-blocked/40 px-2 py-0.5 text-[11px] text-blocked"
            >
              {e.source}: {e.error}
            </span>
          ))}
        </div>
      )}

      {/* one tab per org — an org's noise never buries another's */}
      {orgs.length > 0 && (
        <div className="mb-3.5 flex gap-1 border-b border-line px-1">
          {[["__all", state.items.length] as [string, number], ...orgs].map(
            ([name, count]) => {
              const isAll = name === "__all";
              const active = isAll ? org === null : org === name;
              return (
                <button
                  type="button"
                  key={name}
                  onClick={() => setOrg(isAll ? null : name)}
                  className={`flex items-center gap-1.5 border-b-2 px-3 py-[7px] text-[12px] ${
                    active
                      ? "border-copper font-medium text-ink"
                      : "border-transparent text-ink-muted hover:text-ink-soft"
                  }`}
                >
                  {isAll ? "All" : name}
                  <span className="rounded-full bg-copper/12 px-1.5 text-[10px] text-copper">
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>
      )}

      {shown.length === 0
        ? (
          <p className="px-1 pt-2 text-[13px] text-ink-muted">
            No deployments waiting, running, or failed ✓
          </p>
        )
        : (
          <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
            {shown.map((d) => {
              const key = d.url + d.environment;
              return (
                <div
                  key={key}
                  onClick={() => openInBrowser(d.url)}
                  title={d.status === "running"
                    ? "Open the running pipeline"
                    : d.status === "failed"
                    ? "Open the failed pipeline"
                    : "Open the approval page in the browser"}
                  className="flex cursor-pointer items-center gap-3.5 border-b border-line-soft px-3.5 py-[11px] last:border-b-0 hover:bg-card/50"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium">
                      {d.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] text-ink-muted">
                      <SourceChip source={d.source} /> {d.repo}
                      {d.requester ? ` · ${d.requester}` : ""}
                    </span>
                  </span>
                  <span className="w-20 truncate font-mono text-[10.5px] text-ink-muted">
                    {d.ref}
                  </span>
                  <span
                    className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]"
                    style={{
                      color: envColor(d.environment),
                      borderColor: envColor(d.environment) + "66",
                      background: envColor(d.environment) + "1a",
                    }}
                  >
                    {d.environment}
                  </span>
                  <span
                    className={`w-[76px] text-right text-[11px] ${
                      d.status === "failed"
                        ? "text-blocked"
                        : ageColor(d.waitingSince)
                    }`}
                  >
                    {d.status === "running" ? "" : timeAgo(d.waitingSince)}
                  </span>
                  {d.status === "running"
                    ? (
                      <span className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-copper">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-copper" />
                        deploying · {elapsed(d.waitingSince)}
                      </span>
                    )
                    : d.status === "failed"
                    ? (
                      <span
                        className="whitespace-nowrap text-[11.5px] text-blocked"
                        title="pipeline failed — open to inspect the logs"
                      >
                        ✕ failed
                      </span>
                    )
                    : d.action
                    ? (
                      <button
                        type="button"
                        disabled={deploying === key}
                        title={deployErr[key]
                          ? `${deployErr[key]} — click to retry`
                          : d.action.kind === "gitlab-play"
                          ? "run the deploy job"
                          : "approve this deployment"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirming === key) deploy(d, key);
                          else {
                            setConfirming(key);
                            // un-arm after a beat — no stale confirm on another row
                            setTimeout(
                              () =>
                                setConfirming((c) => (c === key ? null : c)),
                              4000,
                            );
                          }
                        }}
                        className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-[11.5px] disabled:opacity-40 ${
                          confirming === key || deployErr[key]
                            ? "border-blocked/60 text-blocked hover:bg-blocked/10"
                            : "border-copper/50 text-copper hover:bg-copper/10"
                        }`}
                      >
                        {deploying === key
                          ? "deploying…"
                          : confirming === key
                          ? "confirm?"
                          : deployErr[key]
                          ? "✕ retry"
                          : "▶ deploy"}
                      </button>
                    )
                    : (
                      <span className="whitespace-nowrap text-[11.5px] text-copper">
                        approve ↗
                      </span>
                    )}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
