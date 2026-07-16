// Loopback = the app itself (vite dev proxies /api from :5173); an attacker page keeps
// its own public origin even when it rebinds DNS to 127.0.0.1.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// Only ever asserted, never assumed: non-browser clients (track.ts, MCP) send neither
// header and stay allowed. Sec-Fetch-Site also catches origin-less `<img src=…/api/…>`.
export function isCrossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  return Boolean(origin) && !LOOPBACK_ORIGIN.test(origin!);
}
