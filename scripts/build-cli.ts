// Compiles dist/tramecli with the build stamp baked in. `deno compile --env-file`
// embeds the vars in the binary, so `tramecli --version` reports the commit it was
// built from — the package version only moves on releases, which makes two builds of
// the same release indistinguishable exactly when you need to tell them apart.
// Run via `deno task compile:cli`.

const ROOT = new URL("../", import.meta.url).pathname;

async function git(...args: string[]): Promise<string> {
  const res = await new Deno.Command("git", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  }).output();
  return res.success ? new TextDecoder().decode(res.stdout).trim() : "";
}

const sha = await git("rev-parse", "--short", "HEAD");
// a dirty tree means the binary matches no commit — say so rather than name one
const dirty = sha && (await git("status", "--porcelain")) ? "-dirty" : "";
const build = sha ? `${sha}${dirty}` : "src";

await Deno.mkdir(`${ROOT}dist`, { recursive: true });
const envFile = `${ROOT}dist/.build.env`;
await Deno.writeTextFile(envFile, `TRAME_BUILD=${build}\n`);
try {
  const res = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--config",
      "deno.json",
      `--env-file=${envFile}`,
      "-A",
      "-o",
      "../dist/tramecli",
      "../track/cli.ts",
    ],
    cwd: `${ROOT}app`,
  }).output();
  if (!res.success) Deno.exit(res.code);
} finally {
  await Deno.remove(envFile).catch(() => {});
}
console.log(`compiled dist/tramecli (build ${build})`);
