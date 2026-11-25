// Writes the licence notices of the third-party Rust crates and JS packages shipped in the packages.
// USAGE: node scripts/third-party-licenses.ts <output file>   (run after `npm ci --prefix app/web`)
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SHIPPED = ["trame-desktop", "trame-cli"];
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;
const SEP = "=".repeat(80);

type Entry = { name: string; version: string; license: string; files: { name: string; text: string }[] };

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/third-party-licenses.ts <output file>");
  process.exit(2);
}

const run = (cmd: string[]) => {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30 }).toString().trim();
  } catch {
    console.error(`${cmd.join(" ")} failed`);
    process.exit(1);
  }
};

async function licenceFiles(dir: string): Promise<Entry["files"]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: Entry["files"] = [];
  for (const name of names.filter((n) => LICENCE_FILE.test(n)).sort()) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) files.push({ name, text: (await readFile(join(dir, name), "utf8")).trim() });
  }
  return files;
}

// Rust
const host = run(["rustc", "-vV"]).match(/^host: (.+)$/m)![1];
type Pkg = { id: string; name: string; version: string; license: string | null; license_file?: string; manifest_path: string };
type Node = { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] };
const meta = JSON.parse(run(["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", host]));
const pkgs = new Map<string, Pkg>(meta.packages.map((p: Pkg) => [p.id, p]));
const nodes = new Map<string, Node>(meta.resolve.nodes.map((n: Node) => [n.id, n]));
const members = new Set<string>(meta.workspace_members);
const roots = [...members].filter((id) => SHIPPED.includes(pkgs.get(id)!.name));
if (roots.length !== SHIPPED.length) {
  console.error(`shipped crates not found in the workspace: ${SHIPPED.join(", ")}`);
  process.exit(1);
}
const seen = new Set<string>(roots);
const stack = [...roots];
while (stack.length) {
  for (const d of nodes.get(stack.pop()!)!.deps) {
    if (!d.dep_kinds.some((k) => k.kind !== "dev") || seen.has(d.pkg) || members.has(d.pkg)) continue;
    seen.add(d.pkg);
    stack.push(d.pkg);
  }
}
const entries = new Map<string, Entry>();
let crates = 0;
for (const id of seen) {
  if (members.has(id)) continue;
  const p = pkgs.get(id)!;
  const key = `rust:${p.name}@${p.version}`;
  if (entries.has(key)) continue;
  crates++;
  entries.set(key, { name: p.name, version: p.version, license: p.license ?? p.license_file ?? "UNKNOWN", files: await licenceFiles(dirname(p.manifest_path)) });
}

// JS
const web = join(ROOT, "app/web");
const pkgJson = async (dir: string) => JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
const licenseOf = (j: { license?: unknown; licenses?: { type: string }[] }) =>
  typeof j.license === "string" ? j.license : (j.license as { type?: string } | undefined)?.type ?? j.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN";
// node resolution: nearest node_modules/<name> walking up from `from`
async function resolveDir(name: string, from: string): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    const cand = join(dir, "node_modules", name);
    if (await stat(join(cand, "package.json")).then(() => true, () => false)) return cand;
    if (dir === dirname(dir) || dir === ROOT) return null;
  }
}
const visited = new Set<string>();
let js = 0;
const rootJson = await pkgJson(web);
const queue: [string, string][] = Object.keys(rootJson.dependencies ?? {}).map((n) => [n, web]);
while (queue.length) {
  const [name, from] = queue.pop()!;
  const dir = await resolveDir(name, from);
  if (!dir) {
    if (from === web && !(name in (rootJson.optionalDependencies ?? {}))) {
      console.error(`${name} is not installed: run npm ci --prefix app/web first`);
      process.exit(1);
    }
    continue; // uninstalled optional dependency
  }
  if (visited.has(dir)) continue;
  visited.add(dir);
  const j = await pkgJson(dir);
  const key = `js:${j.name ?? name}@${j.version}`;
  if (!entries.has(key)) {
    js++;
    entries.set(key, { name: j.name ?? name, version: j.version ?? "?", license: licenseOf(j), files: await licenceFiles(dir) });
  }
  for (const n of [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.optionalDependencies ?? {})]) queue.push([n, dir]);
}

const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b));
const missing = sorted.filter(([, e]) => e.files.length === 0).length;
const sha = run(["git", "rev-parse", "--short", "HEAD"]);
const parts = [`Third-party licence notices of the Rust crates and JS packages compiled into Trame. Generated from commit ${sha}.\n`];
for (const [key, e] of sorted) {
  parts.push(SEP, `${e.name} ${e.version} (${key.split(":")[0]})`, `License: ${e.license}`, SEP);
  if (e.files.length === 0) parts.push("(no licence file in the package)");
  for (const f of e.files) parts.push(`--- ${f.name} ---`, f.text, "");
  parts.push("");
}
await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(out, parts.join("\n"));
console.error(`third-party licences: ${crates} crates, ${js} JS packages, ${missing} without a licence file -> ${out}`);
