import { expect, test } from "bun:test";
import { trameHttpTarget, trameScheme } from "./trame-links.ts";

const ID = "9bf1c19c-1c78-4925-94b5-0187b6724d54";

test("trame:// links name a card, page, db, board query or saved view", () => {
  for (
    const [uri, want] of [
      [`trame://agent/${ID.replaceAll("-", "")}`, { kind: "agent", run: ID.replaceAll("-", "") }],
      [`trame://agent/${ID}`, null],
      [`trame://card/${ID}`, { kind: "card", id: ID }],
      [`trame://session/${ID}/`, { kind: "card", id: ID }],
      [`trame://page/${ID}?x=1#b`, { kind: "page", id: ID }],
      [`trame://db/${ID}`, { kind: "db", id: ID }],
      ["trame://board?q=tag%3Aparked", { kind: "board", q: "tag:parked" }],
      ["trame://board", { kind: "board", q: "" }],
      ["trame://view/My%20views", { kind: "view", name: "My views" }],
      // malformed ids, unknown kinds and other schemes are not Trame targets
      ["trame://card/not-an-id", null],
      ["trame://view/a/b", null],
      ["trame://view/", null],
      ["trame://thing/x", null],
      [`https://x.test/?card=${ID}`, null],
    ] as const
  ) expect(trameScheme(uri)).toEqual(want);
});

test("http links to a local Trame name their card or page", () => {
  const origin = "http://127.0.0.1:41995";
  for (
    const [uri, want] of [
      [`${origin}/?view=card&card=${ID}`, { kind: "card", id: ID }],
      [`http://localhost:5000/?session=${ID}`, { kind: "card", id: ID }],
      [`${origin}/?page=${ID}`, { kind: "page", id: ID }],
      [`${origin}/?view=board`, null],
      [`https://example.com/?card=${ID}`, null],
      ["not a url", null],
    ] as const
  ) expect(trameHttpTarget(uri, origin)).toEqual(want);
});
