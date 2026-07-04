// In-app updates. Check: compare deno.json's version against the latest GitHub
// release. Apply: only possible when running as a Linux AppImage ($APPIMAGE is the
// image path) — download the new image next to it and rename over; the running
// process keeps its inode, the next launch is the new version. Other installs
// (deb/dmg/snap/source) get pointed at the release page instead.
import cfg from "./deno.json" with { type: "json" };

const REPO = "Andarius/trame";
const CHECK_TTL_MS = 60 * 60 * 1000;

export const VERSION: string = cfg.version;

export type UpdateInfo = {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string;
  canSelfUpdate: boolean; // AppImage on Linux — apply replaces the image in place
  applied: boolean; // a newer image is already in place — next launch runs it
};

const newer = (a: string, b: string): boolean => {
  // true when a > b (plain x.y.z)
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
};

const appImagePath = () => Deno.env.get("APPIMAGE") ?? null;

let cache: { at: number; info: UpdateInfo } | null = null;
let latestAssetUrl: string | null = null;
let applied = false;

export async function checkUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cache && Date.now() - cache.at < CHECK_TTL_MS) return cache.info;
  const info: UpdateInfo = {
    current: VERSION,
    latest: null,
    available: false,
    releaseUrl: `https://github.com/${REPO}/releases/latest`,
    canSelfUpdate: Deno.build.os === "linux" && Boolean(appImagePath()),
    applied,
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const rel = await res.json();
      const tag = String(rel.tag_name ?? "").replace(/^v/, "");
      info.latest = tag || null;
      info.available = Boolean(tag) && newer(tag, VERSION);
      info.releaseUrl = rel.html_url ?? info.releaseUrl;
      const asset = (rel.assets ?? []).find((a: { name: string }) => /linux.*\.AppImage$/i.test(a.name));
      latestAssetUrl = asset?.browser_download_url ?? null;
    }
  } catch { /* offline or rate-limited — report current state, retry after TTL */ }
  cache = { at: Date.now(), info };
  return info;
}

export async function applyUpdate(): Promise<{ ok: boolean; error?: string }> {
  const target = appImagePath();
  if (!target || Deno.build.os !== "linux") return { ok: false, error: "self-update only works for the AppImage" };
  const info = await checkUpdate(true);
  if (!info.available) return { ok: false, error: "already up to date" };
  if (!latestAssetUrl) return { ok: false, error: "no AppImage asset on the latest release" };
  const tmp = `${target}.new`;
  try {
    const res = await fetch(latestAssetUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) return { ok: false, error: `download failed (${res.status})` };
    const f = await Deno.open(tmp, { write: true, create: true, truncate: true, mode: 0o755 });
    await res.body.pipeTo(f.writable); // closes f
    await Deno.chmod(tmp, 0o755);
    await Deno.rename(tmp, target); // atomic: the running image keeps its inode
    applied = true;
    cache = null;
    return { ok: true };
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    return { ok: false, error: (e as Error).message };
  }
}

// Background auto-update: silently swap the AppImage when a newer release exists;
// the pill flips to "restart" and the next launch runs the new version.
export async function autoUpdateTick(enabled: () => Promise<boolean>): Promise<void> {
  try {
    if (applied || !(await enabled())) return;
    const info = await checkUpdate();
    if (info.available && info.canSelfUpdate) {
      const r = await applyUpdate();
      if (r.ok) console.log(`auto-updated to v${info.latest} — restart to run it`);
    }
  } catch { /* next tick retries */ }
}
