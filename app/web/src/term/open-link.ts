import { getPage, getUdb, openInBrowser } from "../api";
import { openWorkspaceAt } from "../app/workspaces";
import { type TrameTarget, trameScheme } from "./trame-links";

// Trame's own links (what `tramecli` prints, from this app or another port on this machine) open in a
// workspace of their own, so the terminal stays where it is; anything else goes to the browser
export function openLink(uri: string) {
  const scheme = trameScheme(uri);
  if (scheme) return openTrame(scheme);
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  const trame = u.origin === location.origin || (loopback && /[?&](card|session|page|db)=/.test(u.search));
  if (!trame) {
    void openInBrowser(uri);
    return;
  }
  const q = new URLSearchParams(u.search);
  const legacy = q.get("session");
  if (legacy && !q.get("card")) {
    q.delete("session");
    q.set("card", legacy);
  }
  const search = `?${q}`;
  const [card, page, db] = [q.get("card"), q.get("page"), q.get("db")];
  if (card) return openWorkspaceAt(card, search);
  if (page) return void getPage(page).then((p) => p.title, () => undefined).then((t) => openWorkspaceAt(`page:${page}`, search, t));
  if (db) return void getUdb(db).then((d) => d.db.name, () => undefined).then((n) => openWorkspaceAt(`db:${db}`, search, n));
  history.pushState(null, "", `/${search}`);
  dispatchEvent(new PopStateEvent("popstate"));
}

// a trame:// link opens here, in a workspace like this app's own http links, never through the OS
function openTrame(t: TrameTarget) {
  if (t.kind === "card") return openWorkspaceAt(t.id, `?view=card&card=${t.id}`);
  if (t.kind === "page") {
    return void getPage(t.id).then((p) => p.title, () => undefined).then((n) => openWorkspaceAt(`page:${t.id}`, `?page=${t.id}`, n));
  }
  if (t.kind === "db") {
    return void getUdb(t.id).then((d) => d.db.name, () => undefined).then((n) => openWorkspaceAt(`db:${t.id}`, `?db=${t.id}`, n));
  }
  // a saved view is resolved by name server side
  if (t.kind === "view") {
    return void fetch("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: t.name }) });
  }
  if (!("q" in t)) return;
  history.pushState(null, "", `/?${new URLSearchParams({ view: "board", group: "none", q: t.q })}`);
  dispatchEvent(new PopStateEvent("popstate"));
}
