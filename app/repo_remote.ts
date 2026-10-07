// A repo path's origin as a web link (GitHub / GitLab), for the card's Repo field.

// git@host:owner/repo.git, ssh://git@host/owner/repo, https://host/owner/repo.git → https://host/owner/repo
export function remoteToWeb(remote: string): string | null {
  const m = remote.trim().match(
    /^(?:git@([^:]+):|ssh:\/\/git@([^/:]+)(?::\d+)?\/|https?:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?\/?$/,
  );
  if (!m) return null;
  return `https://${m[1] ?? m[2] ?? m[3]}/${m[4]}`;
}

const cache = new Map<string, string | null>();

export async function repoWebUrl(path: string): Promise<string | null> {
  if (cache.has(path)) return cache.get(path)!;
  const out = await new Deno.Command("git", {
    args: ["-C", path, "remote", "get-url", "origin"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  const url = out?.success ? remoteToWeb(new TextDecoder().decode(out.stdout)) : null;
  cache.set(path, url);
  return url;
}
