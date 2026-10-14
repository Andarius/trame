export const EMBED_DEFAULT_HEIGHT = 600;

// The URL's host when it is https and its hostname is allowlisted; null otherwise.
export function allowedEmbedHost(url: string, hosts: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const allowed = hosts.some((h) => h.trim().toLowerCase() === u.hostname);
  return allowed ? u.host : null;
}
