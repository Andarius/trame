// Fetches native plugins from GitHub and composes them into this checkout for a build.
// USAGE: bun scripts/compose-plugins.ts <plugins.json> [--lock <out.json>]
//   plugins.json: { "plugins": ["owner/repo", "owner/repo@v1.2.0", "owner/plugins/name"] }   (no tag = latest release)
// `owner/repo/name` is one plugin of a plugins repo: its `plugins/<name>/`, released as `<name>-vX.Y.Z`.
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

/** `repo` is the spec without its tag; `name` the plugin inside a plugins repo, else null. */
export type Spec = { repo: string; ref: string | null; name: string | null };
export function parseSpec(entry: string): Spec {
  const [repo, ref = null, ...extra] = entry.split("@");
  const parts = repo.split("/");
  if (extra.length || parts.length < 2 || parts.length > 3 || !parts.every((p) => NAME.test(p))) {
    throw new Error(`not owner/repo[/name][@tag]: ${JSON.stringify(entry)}`);
  }
  if (ref !== null && (!REF.test(ref) || ref.includes(".."))) throw new Error(`bad tag in ${JSON.stringify(entry)}`);
  return { repo, ref, name: parts[2] ?? null };
}

/** `owner/repo` of a spec, the GitHub repository to clone. */
export const githubRepo = (s: Spec) => s.repo.split("/").slice(0, 2).join("/");

/** The newest `<name>-vX.Y.Z` among release tags (drafts and prereleases skipped). */
export function newestFor(releases: { tag_name: string; draft?: boolean; prerelease?: boolean }[], name: string) {
  const prefix = `${name}-v`;
  const key = (t: string) => t.slice(prefix.length).split(".").map(Number);
  return releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(r.tag_name.slice(prefix.length)))
    .map((r) => r.tag_name)
    .sort((a, b) => key(b).map((x, i) => x - key(a)[i]).find((d) => d !== 0) ?? 0)[0] ?? null;
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

async function latestTag(spec: Spec) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "Trame" };
  const token = process.env.GITHUB_TOKEN || ghToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const gh = githubRepo(spec);
  const none = (why: string) => fail(`${spec.repo}: no release to build (${why}); pin a tag with ${spec.repo}@<tag>`);
  if (spec.name) {
    const res = await fetch(`https://api.github.com/repos/${gh}/releases?per_page=100`, { headers });
    if (!res.ok) none(String(res.status));
    return newestFor(await res.json(), spec.name) ?? none(`no ${spec.name}-v* release`);
  }
  const res = await fetch(`https://api.github.com/repos/${gh}/releases/latest`, { headers });
  if (!res.ok) none(String(res.status));
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
  // owner names have no "_", so owner__repo[__name] cannot collide
  const cloneDir = (s: Spec) => join(DIR, s.repo.replaceAll("/", "__"));
  const pluginDir = (s: Spec) => s.name ? join(cloneDir(s), "plugins", s.name) : cloneDir(s);
  for (const spec of specs) {
    const { repo, ref } = spec;
    const tag = ref ?? await latestTag(spec);
    const url = `https://github.com/${githubRepo(spec)}.git`;
    const clone = cloneDir(spec);
    const dir = pluginDir(spec);
    const commit = tagCommit(url, tag) ?? fail(`${repo}: ${tag} is not a tag`);
    git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, clone]);
    if (git(["rev-parse", "HEAD"], clone) !== commit) fail(`${repo}: ${tag} moved while cloning`);
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

  const paths = specs.map((s) => relative(ROOT, pluginDir(s)));
  await writeFile(LOCAL, JSON.stringify({ composed: true, plugins: paths }, null, 2) + "\n");
  const gen = Bun.spawnSync(["bun", join(ROOT, "scripts/gen-plugins.ts")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (gen.exitCode !== 0) process.exit(gen.exitCode ?? 1);

  const text = JSON.stringify({ trame, plugins: lock }, null, 2) + "\n";
  await writeFile(resolve(lockOut ?? join(DIR, "lock.json")), text);
  process.stdout.write(text);
}
