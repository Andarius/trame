import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type MirrorPage,
  planMirror,
  REF_MARK,
  refOfContent,
  ticketBlocks,
  ticketMarkdown,
} from "./mirror.ts";
import type { Ticket } from "./api.ts";

// Mirroring is the first thing this plugin writes to the Trame database, and
// removal is the only destructive step. The cases that matter most are the ones
// where the server told us LESS than usual: nothing may be deleted on a blip.

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "00000000-0000-0000-0000-000000000001",
  reference: "CKP-1",
  title: "Réparer le picker",
  description: "Le picker écrit dans une colonne absente.",
  objective: null,
  design_figma_url: null,
  status: "in_progress",
  review_status: null,
  deployment_status: null,
  priority: 2,
  scope: "front",
  commit_type: "fix",
  standalone_section: null,
  user_story_id: null,
  product_id: null,
  flow_id: null,
  assignee_id: null,
  created_by: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  completed_at: null,
  archived_at: null,
  meta: null,
  ...over,
});

const pageOf = (t: Ticket, id = "page-1"): MirrorPage => ({
  id,
  ref: t.reference,
  title: `${t.reference} — ${t.title}`,
  content: ticketBlocks(t),
});

Deno.test("ticketMarkdown keeps the reference and the description", () => {
  const md = ticketMarkdown(ticket());
  assertEquals(md.startsWith("# CKP-1 — Réparer le picker"), true);
  assertEquals(md.includes("**Statut** — in_progress"), true);
  assertEquals(md.includes("colonne absente"), true);
});

Deno.test("ticketMarkdown omits the fields a ticket has not set", () => {
  const md = ticketMarkdown(ticket());
  assertEquals(md.includes("**Revue**"), false);
  assertEquals(md.includes("**Objectif**"), false);
});

Deno.test("ticketBlocks stamps the reference on the first block", () => {
  const blocks = ticketBlocks(ticket());
  assertEquals(blocks[0].text.includes(`{{trame:${REF_MARK}=CKP-1}}`), true);
  assertEquals(refOfContent(blocks), "CKP-1");
});

Deno.test("refOfContent ignores a page that is not a mirror", () => {
  assertEquals(refOfContent([{ type: "text", text: "notes", id: "a" }]), null);
  assertEquals(refOfContent([]), null);
  // a non-text block must not throw the reader off
  assertEquals(refOfContent([{ type: "database", db_id: "x" }]), null);
});

Deno.test("planMirror creates a page for a ticket it has never seen", () => {
  const plan = planMirror([ticket()], [], ["CKP-1"]);
  assertEquals(plan.create.length, 1);
  assertEquals(plan.create[0].ref, "CKP-1");
  assertEquals(plan.update.length, 0);
  assertEquals(plan.remove.length, 0);
});

Deno.test("planMirror updates rather than duplicates a known ticket", () => {
  const t = ticket();
  const plan = planMirror([t], [pageOf(t)], ["CKP-1"]);
  assertEquals(plan.create.length, 0);
  assertEquals(plan.update.length, 1);
  assertEquals(plan.update[0].id, "page-1");
});

Deno.test("planMirror keeps block ids for lines that did not change", () => {
  // This is why mirroring merges instead of replacing: a reader's comment is
  // anchored to a block id, and a rewrite that renumbers every block orphans it.
  const before = ticket();
  const page = pageOf(before);
  const descId = (page.content[2] as { id: string }).id;

  const plan = planMirror(
    [ticket({ title: "Titre réécrit" })],
    [page],
    ["CKP-1"],
  );
  const merged = plan.update[0].blocks as { id: string; text: string }[];
  const desc = merged.find((b) => b.text.includes("colonne absente"))!;
  assertEquals(desc.id, descId, "unchanged description keeps its id");
  // the heading did change, so it is allowed a new identity
  assertNotEquals(merged[0].text, (page.content[0] as { text: string }).text);
});

Deno.test("planMirror retires a page whose ticket left the scope", () => {
  const gone = ticket({ reference: "CKP-9" });
  const plan = planMirror([ticket()], [pageOf(ticket()), pageOf(gone, "p9")], [
    "CKP-1",
  ]);
  assertEquals(plan.remove, [{ id: "p9", ref: "CKP-9" }]);
});

Deno.test("planMirror removes NOTHING when /refs could not be read", () => {
  // A failed refs call means we do not know what is live. Deleting on that
  // would wipe every mirrored page — and its comments — on a network blip.
  const t = ticket();
  const plan = planMirror([], [pageOf(t)], null);
  assertEquals(plan.remove, []);
});

Deno.test("planMirror removes nothing when the scope is simply empty", () => {
  // An empty-but-successful refs answer is different from a failed one: the
  // page really is gone from the scope, so retiring it is correct.
  const t = ticket();
  const plan = planMirror([], [pageOf(t)], []);
  assertEquals(plan.remove.length, 1);
});
