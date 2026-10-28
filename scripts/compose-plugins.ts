// Fetches native plugins from GitHub and composes them into this checkout for a build.
// USAGE: bun scripts/compose-plugins.ts <plugins.json> [--lock <out.json>]
//   plugins.json: { "plugins": ["owner/repo", "owner/repo@v1.2.0"] }   (no tag = latest release)
// Clones each into .scratch/plugins/, refuses one whose `TRAME` range (version.ts) excludes this
// Trame, writes plugins.local.json, runs gen-plugins, and writes a lock (Trame version + each
// plugin's tag, commit and range) that identifies the build.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = join(ROOT, ".scratch/plugins");
const LOCAL = join(ROOT, "plugins.local.json");
const exists = (p: string) => stat(p).then(() => true, () => false);
const fail = (msg: string): never => {
  console.error(`compose-plugins: ${msg}`);
  process.exit(1);
};

// same rule as plugin_updates::valid_repo: safe in an API path and a directory name
const NAME = /^(?!\.)[A-Za-z0-9._-]+$/;
const REF = /^(?![-.])[A-Za-z0-9._/-]+$/;

export type Spec = { repo: string; ref: string | null };
export function parseSpec(entry: string): Spec {
  const [repo, ref = null, ...extra] = entry.split("@");
  const parts = repo.split("/");
  if (extra.length || parts.length !== 2 || !parts.every((p) => NAME.test(p))) {
    throw new Error(`not owner/repo[@tag]: ${JSON.stringify(entry)}`);
  }
  if (ref !== null && (!REF.test(ref) || ref.includes(".."))) throw new Error(`bad tag in ${JSON.stringify(entry)}`);
  return { repo, ref };
}

const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/;

/** Whether `version` (x.y.z) meets every space-separated comparator in `range`, e.g. ">=0.24.0 <0.25.0". */
export function satisfies(version: string, range: string): boolean {
  const parts = (v: string) => v.split(".").map(Number);
  const cmp = (a: number[], b: number[]) => a.map((x, i) => x - b[i]).find((d) => d !== 0) ?? 0;
  const have = parts(version);
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (!comparators.length) throw new Error(`empty Trame range`);
  return comparators.every((c) => {
    const m = COMPARATOR.exec(c);
    if (!m) throw new Error(`bad Trame range ${JSON.stringify(range)}`);
    const d = cmp(have, [m[2], m[3], m[4]].map(Number));
    return { ">=": d >= 0, "<=": d <= 0, ">": d > 0, "<": d < 0, "=": d === 0 }[m[1] ?? "="];
  });
}

/** The `TRAME` range a plugin checkout declares in version.ts, or null. */
export async function trameRange(dir: string): Promise<string | null> {
  const text = await readFile(join(dir, "version.ts"), "utf8").catch(() => "");
  return /export const TRAME = "([^"]+)"/.exec(text)?.[1] ?? null;
}

// a private plugin repo needs a token; locally that is the gh login git already clones with
function ghToken() {
  try {
    const out = Bun.spawnSync(["gh", "auth", "token"], { stderr: "ignore" });
    return out.exitCode === 0 ? out.stdout.toString().trim() : "";
  } catch {
    return ""; // no gh installed
  }
}

async function latestTag(repo: string) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "Trame" };
  const token = process.env.GITHUB_TOKEN || ghToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) fail(`${repo}: no release to build (${res.status}); pin a tag with ${repo}@<tag>`);
  return ((await res.json()) as { tag_name: string }).tag_name;
}

// the commit a tag points at (peeled for an annotated tag), or null when `tag` is not a tag
function tagCommit(url: string, tag: string) {
  const lines = git(["ls-remote", "--tags", url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split("\n").filter(Boolean);
  const pick = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
  return pick?.split("\t")[0] ?? null;
}

function git(args: string[], cwd = ROOT) {
  const out = Bun.spawnSync(["git", "-c", "advice.detachedHead=false", ...args], { cwd, stderr: "pipe" });
  if (out.exitCode !== 0) fail(`git ${args.join(" ")}: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

if (import.meta.main) {
  const [specFile, flag, lockOut] = process.argv.slice(2);
  if (!specFile || (flag && (flag !== "--lock" || !lockOut))) fail("usage: compose-plugins.ts <plugins.json> [--lock <out.json>]");
  const entries: unknown = JSON.parse(await readFile(specFile, "utf8")).plugins;
  if (!Array.isArray(entries) || !entries.every((e) => typeof e === "string")) fail(`${specFile}: "plugins" must be a list of strings`);
  let specs: Spec[] = [];
  try {
    specs = (entries as string[]).map(parseSpec);
  } catch (e) {
    fail((e as Error).message);
  }
  const repos = specs.map((s) => s.repo.toLowerCase());
  const dup = repos.find((r, i) => repos.indexOf(r) !== i);
  if (dup) fail(`${dup} is listed twice`);

  // a hand-written plugins.local.json is a dev's own list: never overwrite it
  if (await exists(LOCAL) && !JSON.parse(await readFile(LOCAL, "utf8")).composed) {
    fail(`${LOCAL} is not from compose-plugins; move it away first`);
  }

  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const trame: string = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const lock = [];
  for (const { repo, ref } of specs) {
    const tag = ref ?? await latestTag(repo);
    // owner names have no "_", so owner__repo cannot collide
    const dir = join(DIR, repo.replace("/", "__"));
    const url = `https://github.com/${repo}.git`;
    const commit = tagCommit(url, tag) ?? fail(`${repo}: ${tag} is not a tag`);
    git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, dir]);
    if (git(["rev-parse", "HEAD"], dir) !== commit) fail(`${repo}: ${tag} moved while cloning`);
    if (!await exists(join(dir, "src/mod.rs"))) {
      fail(`${repo}@${tag} has no src/mod.rs: only native plugins can be composed`);
    }
    const range = await trameRange(dir) ?? fail(`${repo}@${tag} declares no TRAME range in version.ts`);
    let ok = false;
    try {
      ok = satisfies(trame, range);
    } catch (e) {
      fail(`${repo}@${tag}: ${(e as Error).message}`);
    }
    if (!ok) fail(`${repo}@${tag} needs Trame ${range}, this is ${trame}; pin a matching plugin tag`);
    lock.push({ repo, tag, commit, trame: range });
  }

  const paths = specs.map(({ repo }) => relative(ROOT, join(DIR, repo.replace("/", "__"))));
  await writeFile(LOCAL, JSON.stringify({ composed: true, plugins: paths }, null, 2) + "\n");
  const gen = Bun.spawnSync(["bun", join(ROOT, "scripts/gen-plugins.ts")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (gen.exitCode !== 0) process.exit(gen.exitCode ?? 1);

  const text = JSON.stringify({ trame, plugins: lock }, null, 2) + "\n";
  await writeFile(resolve(lockOut ?? join(DIR, "lock.json")), text);
  process.stdout.write(text);
}
