// Fetches native plugins from GitHub and composes them into this checkout for a build.
// USAGE: bun scripts/compose-plugins.ts <plugins.json> [--lock <out.json>]
//   plugins.json: { "plugins": ["owner/repo", "owner/repo@v1.2.0"] }   (no tag = latest release)
// Clones each into .scratch/plugins/, writes plugins.local.json, runs gen-plugins, and writes a
// lock (Trame version + each plugin's tag and commit) that identifies the build.
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
const REF = /^(?![-.])[A-Za-z0-9._\/-]+$/;

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

async function latestTag(repo: string) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "Trame" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
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
    lock.push({ repo, tag, commit });
  }

  const paths = specs.map(({ repo }) => relative(ROOT, join(DIR, repo.replace("/", "__"))));
  await writeFile(LOCAL, JSON.stringify({ composed: true, plugins: paths }, null, 2) + "\n");
  const gen = Bun.spawnSync(["bun", join(ROOT, "scripts/gen-plugins.ts")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (gen.exitCode !== 0) process.exit(gen.exitCode ?? 1);

  const trame = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const text = JSON.stringify({ trame, plugins: lock }, null, 2) + "\n";
  await writeFile(resolve(lockOut ?? join(DIR, "lock.json")), text);
  process.stdout.write(text);
}
