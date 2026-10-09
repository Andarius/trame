// `tramecli deployments ships` — read or set the per-repo rules that match waiting releases to cards.
import { apiRequest, resolveTarget } from "./target.ts";

type Rule = { pattern?: string; environments?: string[]; backport?: boolean };
type View = {
  githubRepos: string[];
  gitlabProjects: string[];
  ships: Record<string, Rule>;
  shipDefaults: Record<"github" | "gitlab", Required<Rule>>;
};

const SETTINGS = "/api/plugins/deployments/settings";

// The full override map after applying `argv` flags to `repo`; the API replaces the whole map on write.
export function applyFlags(ships: Record<string, Rule>, repo: string, argv: string[]): Record<string, Rule> {
  const { [repo]: old = {}, ...rest } = ships;
  if (argv.includes("--reset")) return rest;
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const rule: Rule = { ...old };
  const pattern = val("--pattern");
  if (pattern !== undefined) rule.pattern = pattern;
  const env = val("--env");
  if (env !== undefined) rule.environments = env.split(",").map((s) => s.trim()).filter(Boolean);
  if (argv.includes("--backport")) rule.backport = true;
  if (argv.includes("--no-backport")) rule.backport = false;
  return { ...rest, [repo]: rule };
}

function print(v: View, only?: string) {
  const repos = [
    ...v.githubRepos.map((r) => [r, "github"] as const),
    ...v.gitlabProjects.map((r) => [r, "gitlab"] as const),
  ].filter(([r]) => !only || r === only);
  for (const [repo, forge] of repos) {
    const o = v.ships[repo] ?? {};
    const d = v.shipDefaults[forge];
    const env = o.environments?.length ? o.environments.join(",") : "all";
    const mark = Object.keys(o).length ? "  (custom)" : "";
    console.log(
      `${repo} [${forge}]  pattern ${o.pattern ?? d.pattern} · env ${env} · backport ${
        o.backport ?? d.backport ? "on" : "off"
      }${mark}`,
    );
  }
}

export async function main(argv: string[], opts: { json: boolean }) {
  const [sub, repo, ...flags] = argv;
  if (sub !== "ships") throw new Error("usage: tramecli deployments ships [<repo> [flags]] — see --help");
  const t = await resolveTarget();
  let view = await apiRequest(t, SETTINGS) as View;
  if (repo && flags.length) {
    if (![...view.githubRepos, ...view.gitlabProjects].includes(repo)) {
      throw new Error(`${repo} is not a watched repo — add it in the Deployments settings first`);
    }
    view = await apiRequest(t, SETTINGS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ships: applyFlags(view.ships, repo, flags) }),
    }) as View;
    const p = flags.indexOf("--pattern");
    if (p >= 0 && view.ships[repo]?.pattern !== flags[p + 1]?.trim()) {
      console.error("pattern dropped: it must compile and have exactly one capture group, e.g. 'PR-(\\d+)'");
    }
  }
  if (opts.json) console.log(JSON.stringify({ ships: view.ships, shipDefaults: view.shipDefaults }));
  else print(view, repo);
}
