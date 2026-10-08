import { useEffect, useState } from "react";
import { openInBrowser, type PrInfo, prInfo, setStatus } from "./api";

// GitHub PR / GitLab MR URLs — bare or as [text](url) links — render as compact
// chips (icon + repo#42 + title + state, ⧉ badge when stacked), matching the
// session drawer's colors; info resolves lazily via /api/pr-state and is cached
// module-wide so each URL fetches once.
export const PR_HREF =
  /^https?:\/\/[^\s<>)]+\/(?:pull|-\/merge_requests)\/\d+(?:[/?#][^\s<>)]*)?$/;
const PR_STATE_COLOR: Record<string, string> = {
  open: "#7bd88f",
  draft: "#8b93a3",
  merged: "#b590e7",
  closed: "#e06c75",
  unknown: "#5a6172",
};
// short TTL so merged/closed transitions and failed probes both recover
const PR_INFO_TTL_MS = 60_000;
const prInfoCache = new Map<string, { info: PrInfo; at: number }>();
const prInfoPending = new Map<string, Promise<PrInfo>>();
export const getPrInfo = (url: string): Promise<PrInfo> => {
  const hit = prInfoCache.get(url);
  if (hit && Date.now() - hit.at < PR_INFO_TTL_MS) {
    return Promise.resolve(hit.info);
  }
  let p = prInfoPending.get(url);
  if (!p) {
    p = prInfo(url).then((info) => {
      prInfoCache.set(url, { info, at: Date.now() });
      prInfoPending.delete(url);
      return info;
    });
    prInfoPending.set(url, p);
  }
  return p;
};

// repo#42 for GitHub, proj!39 for GitLab; null when the URL has no PR/MR number
function prChipLabel(url: string): string | null {
  try {
    const u = new URL(url);
    const mr = u.pathname.includes("/merge_requests/");
    const m = u.pathname.match(/\/([^/]+)\/(?:pull|-\/merge_requests)\/(\d+)/);
    return m ? `${m[1]}${mr ? "!" : "#"}${m[2]}` : null;
  } catch {
    return null;
  }
}

// inline SVGs (octicon-style) so they render on WebKitGTK
function GitHubMark() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0 text-ink-muted"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
function MergeMark() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-ink-muted"
    >
      <circle cx="3.5" cy="3.5" r="1.8" />
      <circle cx="3.5" cy="12.5" r="1.8" />
      <circle cx="12.5" cy="12.5" r="1.8" />
      <path d="M3.5 5.3v5.4M12.5 10.7V7.5c0-1.7-1.3-3-3-3H7.8M9.6 2.7 7.8 4.5l1.8 1.8" />
    </svg>
  );
}

// active card whose PR is already merged/closed: the agent likely ended without a final track
export function StaleChip(
  { sessionId, prUrl, short = false }: { sessionId: string; prUrl: string | null; short?: boolean },
) {
  const [state, setState] = useState(prUrl ? prInfoCache.get(prUrl)?.info.state : undefined);
  useEffect(() => {
    if (!prUrl) return;
    let alive = true;
    getPrInfo(prUrl).then((i) => alive && setState(i.state));
    return () => {
      alive = false;
    };
  }, [prUrl]);
  if (state !== "merged" && state !== "closed") return null;
  return (
    <span
      title={`PR ${state} but the card is still open — verify and mark done`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#e3c567]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#e3c567]"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {short ? "stale" : `stale · PR ${state}`}
      <button
        type="button"
        title="mark done"
        className="rounded-full px-1 hover:bg-[#e3c567]/25"
        onClick={() => setStatus(sessionId, "done")}
      >
        {short ? "✓" : "✓ done"}
      </button>
    </span>
  );
}

// the repo a PR lives in: https://host/owner/repo
const repoOfPr = (url: string) => url.match(/^(https:\/\/[^/]+\/.+?)\/(?:pull|-\/merge_requests)\/\d+/)?.[1] ?? null;
const repoUrlCache = new Map<string, Promise<string | null>>();
const repoUrlOf = (path: string) => {
  let p = repoUrlCache.get(path);
  if (!p) {
    p = fetch(`/api/repo-remote?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string | null } | null) => d?.url ?? null)
      .catch(() => null);
    repoUrlCache.set(path, p);
  }
  return p;
};

/** A card's repo as its forge link (logo + owner/repo); the local path stays in the tooltip. */
export function RepoLink({ path, prUrl }: { path: string; prUrl?: string | null }) {
  const fromPr = prUrl ? repoOfPr(prUrl) : null;
  const [url, setUrl] = useState<string | null>(fromPr);
  useEffect(() => {
    if (fromPr) return setUrl(fromPr);
    let alive = true;
    repoUrlOf(path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [path, fromPr]);
  const folder = path.replace(/\/+$/, "").split("/").pop() ?? path;
  if (!url) {
    return <span className="font-mono text-[11.5px] text-ink-muted" title={path}>{folder}</span>;
  }
  const [owner, name] = [url.split("/").slice(3, -1).join("/"), url.split("/").pop()];
  return (
    <a
      href={url}
      title={`${url}\n${path}`}
      onClick={(e) => {
        e.preventDefault();
        openInBrowser(url);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-chipline bg-panel px-1.5 py-px font-mono text-[11.5px] text-ink no-underline transition-colors hover:border-copper/60"
    >
      {url.includes("gitlab") ? <MergeMark /> : <GitHubMark />}
      <span className="min-w-0 truncate">
        <span className="text-ink-muted">{owner}/</span>
        {name}
      </span>
    </a>
  );
}

// Sentry issue URLs (bare or [text](url)) — Sentry logo + org + issue id, query dropped
export const SENTRY_ISSUE =
  /^https?:\/\/(?:([\w-]+)\.)?sentry\.io\/(?:organizations\/([\w-]+)\/)?issues\/(\d+)\/?(?:[?#][^\s<>)]*)?/;

export function SentryChip({ url, label }: { url: string; label?: string }) {
  const m = url.match(SENTRY_ISSUE);
  const org = m?.[2] ?? m?.[1];
  return (
    <a
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openInBrowser(url);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-chipline bg-panel px-1.5 py-px align-[-1px] font-mono text-[0.82em] text-ink no-underline transition-colors hover:border-copper/60"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0 text-[#a78bfa]">
        <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.48 15.48 0 0 1 8.53 12.811h-2.221A13.3 13.3 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.2 5.2 0 0 0-1.614-.913L.296 19.275a2.18 2.18 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.32 9.32 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.24 17.24 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287q.043.918 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
      </svg>
      <span className="min-w-0 truncate">
        {label ?? <>{org && <span className="text-ink-muted">{org} </span>}#{m?.[3]}</>}
      </span>
    </a>
  );
}

export function PrChip({ url, label }: { url: string; label?: string }) {
  const [info, setInfo] = useState<PrInfo>(
    prInfoCache.get(url)?.info ?? { state: "unknown" },
  );
  useEffect(() => {
    let alive = true;
    getPrInfo(url).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [url]);
  const parsed = prChipLabel(url);
  const name = label ?? parsed ?? url.replace(/^https?:\/\//, "");
  const color = PR_STATE_COLOR[info.state] ?? PR_STATE_COLOR.unknown;
  return (
    <a
      href={url}
      title={`${url}${info.title ? ` · ${info.title}` : ""} · ${info.state}${
        info.stack ? ` · ${info.stack}` : ""
      }`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openInBrowser(url);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-chipline bg-panel px-1.5 py-px align-[-1px] font-mono text-[0.82em] text-ink no-underline transition-colors hover:border-copper/60"
    >
      {url.includes("/-/merge_requests/") ? <MergeMark /> : <GitHubMark />}
      {/* parsed refs stay whole; free-text labels/URLs truncate in narrow rows */}
      <span className={parsed || label ? "shrink-0" : "min-w-0 truncate"}>
        {name}
      </span>
      {info.title && info.title !== name && (
        <span className="max-w-[240px] truncate font-sans text-ink-muted">
          {info.title}
        </span>
      )}
      {info.state !== "unknown" && (
        <span className="shrink-0" style={{ color }}>{info.state}</span>
      )}
      {info.stack && (
        <span className="shrink-0 text-ink-muted" title={info.stack}>
          ⧉
        </span>
      )}
    </a>
  );
}
