// `git@host:owner/repo.git` from the card's first PR/MR link (GitHub or GitLab)
export function cloneUrl(prUrl: string | null): { url: string; name: string } | null {
  const first = prUrl?.split(/\s+/).find(Boolean);
  if (!first) return null;
  let u: URL;
  try {
    u = new URL(first);
  } catch {
    return null;
  }
  const path = u.pathname.split("/-/")[0].replace(/\/pull\/\d+.*$/, "").replace(/^\/|\/$/g, "");
  if (!path.includes("/")) return null;
  return { url: `git@${u.host}:${path}.git`, name: path };
}
