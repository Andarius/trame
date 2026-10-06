// What a pasted Trame link points at. The app mirrors its state into the query string
// (app/web/src/App.tsx): `card` (the card view), `session` (the side panel) and `page`.
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
  // the card view, then a card open over a page (?page=…&session=…), then the page
  const card = params.get("card");
  if (card && UUID.test(card)) return { kind: "session", id: card };
  const session = params.get("session");
  if (session && UUID.test(session)) return { kind: "session", id: session };
  const page = params.get("page");
  if (page && UUID.test(page)) return { kind: "page", id: page };
  return null;
}
