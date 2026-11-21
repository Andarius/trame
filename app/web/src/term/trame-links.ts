// What a Trame link names: a `trame://` link (what agents report) or this app's own http link.
export type TrameTarget =
  | { kind: "card" | "page" | "db"; id: string }
  | { kind: "board"; q: string }
  | { kind: "view"; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The target of a `trame://card|session|page|db/<id>`, `trame://board?q=…` or `trame://view/<name>` link. */
export function trameScheme(uri: string): TrameTarget | null {
  const m = uri.trim().match(/^trame:\/\/([a-z]+)\/?([^?#]*)(\?[^#]*)?/i);
  if (!m) return null;
  const [, kind, path, query] = m;
  const segs = path.split("/").filter(Boolean);
  switch (kind.toLowerCase()) {
    case "board":
      return segs.length
        ? null
        : { kind: "board", q: new URLSearchParams(query ?? "").get("q") ?? "" };
    case "view": {
      if (segs.length !== 1) return null;
      try {
        return { kind: "view", name: decodeURIComponent(segs[0]) };
      } catch {
        return null;
      }
    }
    case "card":
    case "session":
      return segs.length === 1 && UUID.test(segs[0])
        ? { kind: "card", id: segs[0] }
        : null;
    case "page":
    case "db":
      return segs.length === 1 && UUID.test(segs[0])
        ? { kind: kind.toLowerCase() as "page" | "db", id: segs[0] }
        : null;
    default:
      return null;
  }
}

/** A card or page id an http link to this app (or another local Trame) opens, for its hover preview. */
export function trameHttpTarget(
  uri: string,
  origin: string,
): TrameTarget | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (
    u.origin !== origin &&
    !(loopback && /[?&](card|session|page|db)=/.test(u.search))
  ) return null;
  const q = u.searchParams;
  const card = q.get("card") ?? q.get("session");
  if (card) return { kind: "card", id: card };
  const page = q.get("page");
  if (page) return { kind: "page", id: page };
  const db = q.get("db");
  return db ? { kind: "db", id: db } : null;
}
