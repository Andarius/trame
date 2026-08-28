import { assertEquals } from "@std/assert";
import { parseSessionRef } from "../mcp/session_url.ts";

const SESSION = "bcb4e719-2bdb-4a2a-94f6-c8b5e5e35136";
const PAGE = "3ce5f54e-b00c-4228-82cb-fa3d82392496";
const base = "http://127.0.0.1:8787/";

Deno.test("parseSessionRef reads what a pasted Trame link points at", async (t) => {
  const cases: [string, string, ReturnType<typeof parseSessionRef>][] = [
    ["bare id", SESSION, { kind: "session", id: SESSION }],
    [
      "a card link, page id present but the card wins",
      `${base}?page=${PAGE}&view=page&session=${SESSION}&full=0`,
      { kind: "session", id: SESSION },
    ],
    ["a page link with no card", `${base}?page=${PAGE}&view=page`, {
      kind: "page",
      id: PAGE,
    }],
    ["the board, no ids at all", `${base}?group=story`, null],
    ["not a url and not an id", "Session tracker build", null],
    ["a url whose session param is junk", `${base}?session=nope`, null],
  ];
  for (const [name, input, want] of cases) {
    await t.step(name, () => assertEquals(parseSessionRef(input), want));
  }
});
