import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type AssignedCard,
  assignedCardId,
  assignedMe,
  assignerOf,
  cardFields,
  planAssigned,
  storyOf,
} from "./assigned.ts";
import type { Ticket } from "./api.ts";

const ME = "user-me";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "00000000-0000-0000-0000-000000000001",
  reference: "GEN-1",
  title: "Réparer le picker",
  description: null,
  objective: "Le picker écrit dans la bonne colonne.",
  design_figma_url: null,
  status: "todo",
  review_status: null,
  deployment_status: null,
  priority: 2,
  scope: null,
  commit_type: null,
  standalone_section: null,
  user_story_id: null,
  product_id: null,
  flow_id: null,
  assignee_id: ME,
  created_by: ME,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  completed_at: null,
  archived_at: null,
  meta: null,
  ...over,
});

const card = (over: Partial<AssignedCard> = {}): AssignedCard => ({
  id: "card-1",
  deleted: false,
  terminal: false,
  ...over,
});

const kinds = (
  tickets: Ticket[],
  cards: [string, AssignedCard][] = [],
  held: string[] = [],
) =>
  planAssigned(tickets, ME, new Map(cards), new Set(held)).map((s) => s.kind);

Deno.test("the card id is stable per ref and differs between refs", async () => {
  assertEquals(await assignedCardId("GEN-1"), await assignedCardId("GEN-1"));
  assertNotEquals(await assignedCardId("GEN-1"), await assignedCardId("GEN-2"));
});

Deno.test("me is the token owner, only with the capability; else the mirror skips", () => {
  const cap = { assigned_to_me: true };
  const cases: [Parameters<typeof assignedMe>[0], string | null][] = [
    [{ capabilities: cap, user: { id: ME } }, ME],
    [{ capabilities: cap, user: null }, null],
    [{ capabilities: cap }, null],
    [{ capabilities: cap, user: { id: "" } }, null],
    [{ capabilities: {}, user: { id: ME } }, null],
  ];
  for (const [scopes, expected] of cases) {
    assertEquals(assignedMe(scopes), expected);
  }
});

Deno.test("card fields: ref in title, objective as next step, assigner only when named and not me", () => {
  const cases: [Partial<Ticket>, string][] = [
    [{ created_by: "bob", created_by_name: "Bob" }, "Assigned by Bob"],
    [{ created_by: "bob" }, ""],
    [{ created_by: ME, created_by_name: "Me" }, ""],
  ];
  for (const [over, summary] of cases) {
    assertEquals(cardFields(ticket(over)), {
      title: "GEN-1 — Réparer le picker",
      next_step: "Le picker écrit dans la bonne colonne.",
      summary,
    });
  }
});

Deno.test("assigner: the creator with their avatar, unless unnamed or me", () => {
  const cases: [Partial<Ticket>, ReturnType<typeof assignerOf>][] = [
    [{ created_by: "bob", created_by_name: "Bob", created_by_avatar: "https://a/bob.png" }, {
      name: "Bob",
      avatar: "https://a/bob.png",
    }],
    [{ created_by: "bob", created_by_name: "Bob" }, { name: "Bob", avatar: null }],
    [{ created_by: "bob", created_by_avatar: "https://a/bob.png" }, null],
    [{ created_by: ME, created_by_name: "Me", created_by_avatar: "https://a/me.png" }, null],
  ];
  for (const [over, expected] of cases) assertEquals(assignerOf(ticket(over)), expected);
});

Deno.test("story: the page carrying the ticket's US, else null for the fallback", () => {
  const usRefById = new Map([["us-uuid", "US-7"]]);
  const usPages = new Map([["US-7", { id: "page-us7" }]]);
  const cases: [string | null, string | null][] = [
    ["us-uuid", "page-us7"],
    ["US-7", "page-us7"],
    ["other-uuid", null],
    ["US-8", null],
    [null, null],
  ];
  for (const [user_story_id, expected] of cases) {
    assertEquals(
      storyOf(ticket({ user_story_id }), usRefById, usPages),
      expected,
    );
  }
});

Deno.test("plan: create only open, unrepresented tickets assigned to me", () => {
  const cases: [string, Partial<Ticket>, string[], string[]][] = [
    ["new open ticket", {}, [], ["create"]],
    ["already done", { status: "done" }, [], []],
    ["cancelled", { status: "cancelled" }, [], []],
    ["archived", { archived_at: "2026-10-02T00:00:00Z" }, [], []],
    [
      "filed from a Trame session",
      { meta: { sync: { origin_id: "session:abc" } } },
      [],
      [],
    ],
    ["mirrored as a page already", {}, ["GEN-1"], []],
  ];
  for (const [name, over, held, expected] of cases) {
    assertEquals(
      kinds(
        [ticket(over)],
        [],
        held,
      ),
      expected,
      name,
    );
  }
});

Deno.test("plan: an existing card syncs while mine and closes once gone, never twice", () => {
  const other = ticket({ reference: "GEN-9", status: "done" });
  const cases: [string, Ticket[], Partial<AssignedCard>, string[]][] = [
    ["still mine", [ticket({ status: "in_progress" }), other], {}, ["sync"]],
    ["done in Cockpit is a pull", [ticket({ status: "done" }), other], {}, [
      "sync",
    ]],
    [
      "re-assigned to bob",
      [ticket({ assignee_id: "bob" }), other],
      {},
      ["close"],
    ],
    ["un-assigned to nobody", [ticket({ assignee_id: null }), other], {}, [
      "close",
    ]],
    ["cancelled", [ticket({ status: "cancelled" }), other], {}, ["close"]],
    ["archived", [ticket({ archived_at: "2026-10-02T00:00:00Z" }), other], {}, [
      "close",
    ]],
    ["absent from the feed", [other], {}, ["close"]],
    ["empty feed", [], {}, ["close"]],
    ["gone, card already done", [other], { terminal: true }, []],
    ["card deleted by the user", [ticket(), other], { deleted: true }, []],
  ];
  for (const [name, tickets, over, expected] of cases) {
    assertEquals(kinds(tickets, [["GEN-1", card(over)]]), expected, name);
  }
});

Deno.test("plan: a ref listed twice yields one step", () => {
  assertEquals(kinds([ticket(), ticket()]), ["create"]);
});
