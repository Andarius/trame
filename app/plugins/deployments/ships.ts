// Which open Trame cards a waiting release ships: PR/MR numbers from its commit
// messages, matched against the cards' `pr_url` lines. Tunable per repo.
import type { Ctx } from "../../../core/ctx.ts";
import { addEvent } from "../../../core/sessions.ts";

export type Forge = "github" | "gitlab";

// `pr` is the card's own PR/MR; `via` the other ref on the same commit (a backport), if any.
export type ShippedCard = {
  card_id: string;
  title: string;
  status: string;
  pr: number;
  prUrl: string;
  via: number | null;
  viaUrl: string | null;
};

// Per-repo matching rule, stored in the plugin settings under `ships[repo]`.
export type ShipRule = {
  pattern: string; // regex with one capture group (the PR/MR number), searched in the full commit message
  environments: string[]; // empty = every environment
  backport: boolean; // a second ref on the same commit is the card's backport
};

// GitHub squash/merge titles carry `#N`; GitLab merge commits end with `See merge request group/project!N`.
export const DEFAULT_RULES: Record<Forge, ShipRule> = {
  github: { pattern: "#(\\d+)\\b", environments: [], backport: true },
  gitlab: { pattern: "!(\\d+)\\b", environments: [], backport: true },
};

const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string").map((s) => s.trim())
      .filter(Boolean)
    : [];

const validPattern = (p: unknown): p is string => {
  if (typeof p !== "string" || !p.trim()) return false;
  try {
    return new RegExp(`${p}|`).exec("")?.length === 2; // exactly one capture group
  } catch {
    return false;
  }
};

// The stored rule for `repo`, each missing or invalid field falling back to the forge default.
export function ruleFor(stored: unknown, repo: string, forge: Forge): ShipRule {
  const raw =
    ((stored ?? {}) as Record<string, Record<string, unknown>>)[repo] ?? {};
  const def = DEFAULT_RULES[forge];
  return {
    pattern: validPattern(raw.pattern) ? raw.pattern : def.pattern,
    environments: strs(raw.environments),
    backport: typeof raw.backport === "boolean" ? raw.backport : def.backport,
  };
}

// Settings write path: keep only well-formed overrides for watched repos.
export function sanitizeRules(
  raw: unknown,
  repos: string[],
): Record<string, Partial<ShipRule>> {
  const out: Record<string, Partial<ShipRule>> = {};
  for (
    const [repo, r] of Object.entries(
      (raw ?? {}) as Record<string, Record<string, unknown>>,
    )
  ) {
    if (!repos.includes(repo) || typeof r !== "object" || !r) continue;
    const rule: Partial<ShipRule> = {};
    if (validPattern(r.pattern)) rule.pattern = r.pattern.trim();
    if (strs(r.environments).length) rule.environments = strs(r.environments);
    if (typeof r.backport === "boolean") rule.backport = r.backport;
    if (Object.keys(rule).length) out[repo] = rule;
  }
  return out;
}

export const refNumbers = (message: string, pattern: string): number[] => [
  ...new Set(
    [...message.matchAll(new RegExp(pattern, "g"))].map((m) => Number(m[1])),
  ),
];

// A card's PR/MR link for `repo`; `host` is the GitLab base URL.
export const refUrl = (forge: Forge, host: string, repo: string, n: number) =>
  forge === "github"
    ? `https://github.com/${repo}/pull/${n}`
    : `${host}/${repo}/-/merge_requests/${n}`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `commits` holds one ref-number group per commit of the release.
export function matchCards(
  forge: Forge,
  host: string,
  repo: string,
  commits: number[][],
  cards: { id: string; title: string; status: string; pr_url: string | null }[],
  backport: boolean,
): ShippedCard[] {
  const re = new RegExp(
    forge === "github"
      ? `github\\.com/${escape(repo)}/pull/(\\d+)\\b`
      : `${escape(host.replace(/^https?:\/\//, ""))}/${
        escape(repo)
      }/-/merge_requests/(\\d+)\\b`,
    "gi",
  );
  return cards.flatMap((c) => {
    const own = new Set(
      [...(c.pr_url ?? "").matchAll(re)].map((m) => Number(m[1])),
    );
    const group = commits.find((g) => g.some((n) => own.has(n)));
    const pr = group?.find((n) => own.has(n));
    if (!group || pr === undefined) return [];
    const via = backport ? group.find((n) => n !== pr) ?? null : null;
    return [{
      card_id: c.id,
      title: c.title,
      status: c.status,
      pr,
      prUrl: refUrl(forge, host, repo, pr),
      via,
      viaUrl: via === null ? null : refUrl(forge, host, repo, via),
    }];
  });
}

export async function openCardsWithPrs(
  ctx: Ctx,
): Promise<{ id: string; title: string; status: string; pr_url: string }[]> {
  return (await ctx.q.query(
    `select id, title, status, pr_url from sessions
     where not deleted and pr_url is not null
       and status not in (select key from statuses where terminal and not deleted)`,
  )).rows as { id: string; title: string; status: string; pr_url: string }[];
}

// One worklog line per card per waiting release; the card's own log is the dedupe record.
export async function logWaiting(
  ctx: Ctx,
  cardId: string,
  summary: string,
): Promise<void> {
  const seen = await ctx.q.query(
    `select 1 from session_events where session_id=$1 and summary=$2 and not deleted limit 1`,
    [cardId, summary],
  );
  if (seen.rows.length) return;
  await addEvent(ctx, cardId, summary, "log", "deployments");
}
