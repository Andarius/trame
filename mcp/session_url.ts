// What a pasted Trame link points at. The app mirrors its state into the query string
// (app/web/src/App.tsx), so `session` and `page` are the only ids a link carries.
export type SessionRef = { kind: "session"; id: string } | { kind: "page"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSessionRef(input: string): SessionRef | null {
  const v = input.trim();
  if (UUID.test(v)) return { kind: "session", id: v };
  let params: URLSearchParams;
  try {
    params = new URL(v).searchParams;
  } catch {
    return null;
  }
  // a card wins over the page it sits on — ?page=…&session=… opens the card
  const session = params.get("session");
  if (session && UUID.test(session)) return { kind: "session", id: session };
  const page = params.get("page");
  if (page && UUID.test(page)) return { kind: "page", id: page };
  return null;
}
