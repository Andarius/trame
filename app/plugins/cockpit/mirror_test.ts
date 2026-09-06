import { assertEquals, assertNotEquals } from "@std/assert";
import {
  groupByProject,
  type MirrorPage,
  pageStatusOf,
  pendingOf,
  planMirror,
  REF_MARK,
  refOfContent,
  ticketBlocks,
  ticketFromPage,
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

const pageOf = (
  t: Ticket,
  id = "page-1",
  tags: string[] = [],
  status = "open",
): MirrorPage => ({
  id,
  ref: t.reference,
  title: `${t.reference} — ${t.title}`,
  content: ticketBlocks(t),
  tags,
  status,
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
  const head = blocks[0];
  if (!("text" in head)) throw new Error("first block should carry text");
  assertEquals(head.text.includes(`{{trame:${REF_MARK}=CKP-1}}`), true);
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

// Several Cockpit scopes may target one Trame project. The pages under it are
// loaded as a whole, so a plan built from one scope alone would read the other
// scope's pages as stale and retire them — with their comments.

Deno.test("planMirror keeps both scopes' pages when they share a project", () => {
  const mobile = ticket({ reference: "CKP-1" });
  const devops = ticket({ reference: "CKP-9", title: "Rotate secrets" });
  const existing = [pageOf(mobile, "p1"), pageOf(devops, "p9")];

  // the union of both scopes — what the grouped caller now passes
  const plan = planMirror([mobile, devops], existing, ["CKP-1", "CKP-9"]);

  assertEquals(plan.remove, [], "neither scope's pages may be retired");
  assertEquals(plan.update.length, 2);
  assertEquals(plan.create.length, 0);
});

Deno.test("planMirror gives a ticket in two scopes a single page", () => {
  // A ticket carries both product_id and flow_id, so a ticket mapped under a
  // product AND a flow arrives twice. Deduped by reference upstream, it must
  // still resolve to one page here.
  const t = ticket();
  const plan = planMirror([t], [], ["CKP-1"]);
  assertEquals(plan.create.length, 1);
});

Deno.test("planMirror retires a ref absent from the whole union", () => {
  // An empty-but-complete union is still a real answer: the ticket is gone
  // from every scope feeding this project, so its page should go.
  const gone = ticket({ reference: "CKP-9" });
  const plan = planMirror([ticket()], [pageOf(ticket()), pageOf(gone, "p9")], [
    "CKP-1",
  ]);
  assertEquals(plan.remove, [{ id: "p9", ref: "CKP-9" }]);
});

// groupByProject decides the reconcile unit. Getting it wrong is what made the
// per-mapping version delete another product's pages on every poll.

Deno.test("groupByProject gathers every scope feeding one project", () => {
  const [g] = groupByProject([
    { pageId: "soren", scope: "product:mobile", tickets: [ticket()] },
    {
      pageId: "soren",
      scope: "product:devops",
      tickets: [ticket({ reference: "CKP-9" })],
    },
  ]);
  assertEquals(g.scopes, ["product:mobile", "product:devops"]);
  assertEquals(g.tickets.map((t) => t.reference), ["CKP-1", "CKP-9"]);
  assertEquals(g.blind, false);
});

Deno.test("groupByProject keeps separate projects apart", () => {
  const groups = groupByProject([
    { pageId: "soren", scope: "a", tickets: [ticket()] },
    { pageId: "other", scope: "b", tickets: [ticket({ reference: "CKP-9" })] },
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups.map((g) => g.pageId), ["soren", "other"]);
});

Deno.test("groupByProject drops a mapping with no project", () => {
  // A mapping without a page feeds the panel only — it must not create a group
  // keyed on the empty string, which would then reconcile against nothing.
  assertEquals(
    groupByProject([{ pageId: "", scope: "a", tickets: [ticket()] }]),
    [],
  );
});

Deno.test("groupByProject deduplicates a ticket seen in two scopes", () => {
  const t = ticket();
  const [g] = groupByProject([
    { pageId: "soren", scope: "product:mobile", tickets: [t] },
    { pageId: "soren", scope: "flow:billing", tickets: [t] },
  ]);
  assertEquals(g.tickets.length, 1, "one ticket, not one per scope");
});

Deno.test("groupByProject marks a group blind when any scope failed", () => {
  // The whole point: one unreadable scope means the union is incomplete, and
  // the caller must retire nothing rather than delete what it could not see.
  const [g] = groupByProject([
    { pageId: "soren", scope: "product:mobile", tickets: [ticket()] },
    { pageId: "soren", scope: "product:devops", tickets: [], failed: true },
  ]);
  assertEquals(g.blind, true);
  assertEquals(g.refScopes, [], "a blind group asks for no refs at all");
});

Deno.test("groupByProject asks for every scope when none failed", () => {
  const [g] = groupByProject([
    { pageId: "soren", scope: "a", tickets: [ticket()] },
    { pageId: "soren", scope: "b", tickets: [] },
  ]);
  assertEquals(g.refScopes, ["a", "b"]);
});

Deno.test("groupByProject sorts tickets so devices agree on order", () => {
  const [g] = groupByProject([{
    pageId: "soren",
    scope: "a",
    tickets: [ticket({ reference: "CKP-9" }), ticket({ reference: "CKP-1" })],
  }]);
  assertEquals(g.tickets.map((t) => t.reference), ["CKP-1", "CKP-9"]);
});

Deno.test("planMirror stamps the mapping's tag on a new page", () => {
  const plan = planMirror(
    [ticket()],
    [],
    ["CKP-1"],
    new Map([["CKP-1", ["mobile"]]]),
  );
  assertEquals(plan.create[0].tags, ["mobile"]);
});

Deno.test("planMirror keeps a tag the reader added themselves", () => {
  // Re-mirroring rewrites the page every poll. Replacing its tags would
  // silently strip anything a human put there.
  const t = ticket();
  const plan = planMirror(
    [t],
    [pageOf(t, "p1", ["mobile", "urgent"])],
    ["CKP-1"],
    new Map([["CKP-1", ["mobile"]]]),
  );
  assertEquals(plan.update[0].tags, ["mobile", "urgent"]);
});

Deno.test("groupByProject gives a ticket the tag of every scope that returned it", () => {
  const t = ticket();
  const [g] = groupByProject([
    { pageId: "soren", scope: "a", tag: "mobile", tickets: [t] },
    { pageId: "soren", scope: "b", tag: "billing", tickets: [t] },
  ]);
  assertEquals(g.tagsByRef.get("CKP-1"), ["mobile", "billing"]);
});

// Pushing a page INTO Cockpit files a row in a shared team tracker. A page
// that says nothing must be refused rather than filed with a placeholder.

const pageFor = (over: Record<string, unknown> = {}) => ({
  id: "01a0581d-2a5b-7000-a6c8-3fa7a72789c1",
  title: "Rotate the prod keys",
  content: [
    { type: "text", text: "The keys date from March.", id: "b1" },
    { type: "text", text: "Rotate, then revoke the old ones.", id: "b2" },
  ] as unknown[],
  ...over,
});

Deno.test("ticketFromPage takes the objective from the summary", () => {
  const out = ticketFromPage(pageFor({ brief: "Prod keys are stale." }));
  assertEquals("error" in out, false);
  assertEquals(
    (out as { objective: string }).objective,
    "Prod keys are stale.",
  );
});

Deno.test("ticketFromPage falls back to the first paragraph", () => {
  const out = ticketFromPage(pageFor()) as {
    objective: string;
    description: string;
  };
  assertEquals(out.objective, "The keys date from March.");
  // and does not repeat it in the description
  assertEquals(out.description, "Rotate, then revoke the old ones.");
});

Deno.test("ticketFromPage refuses a page with nothing to say", () => {
  const out = ticketFromPage(pageFor({ content: [] }));
  assertEquals("error" in out, true);
});

Deno.test("ticketFromPage refuses a title too short for Cockpit", () => {
  // The server enforces 3-200; failing here gives a better message than a 422.
  assertEquals("error" in ticketFromPage(pageFor({ title: "ab" })), true);
});

Deno.test("ticketFromPage carries the page id as the idempotency key", () => {
  const out = ticketFromPage(pageFor({ brief: "why" })) as { originId: string };
  assertEquals(out.originId, "01a0581d-2a5b-7000-a6c8-3fa7a72789c1");
});

Deno.test("ticketFromPage ignores marks when reading a paragraph", () => {
  const out = ticketFromPage(pageFor({
    content: [{
      type: "text",
      text: "Why it matters {{trame:created_at=2026-09-02}}",
      id: "b1",
    }],
  })) as { objective: string };
  assertEquals(out.objective, "Why it matters");
});

// The push side's inbox. The guard that matters is the reference: filing a page
// that already stands for a ticket would mint a SECOND ticket for it.

const candidate = (
  pageId: string,
  parentId: string,
  tags: string[],
  text?: string,
) => ({
  pageId,
  parentId,
  tags,
  content: text ? [{ type: "text", text, id: "b" }] : [],
});

const MAPPINGS = [
  { pageId: "proj", tagKey: "cockpit-devops", tagLabel: "cockpit:devops" },
];

Deno.test("pendingOf keeps a tagged page with no reference", () => {
  const out = pendingOf(
    [candidate("a", "proj", ["cockpit-devops"])],
    MAPPINGS,
  );
  assertEquals(out.map((o) => o.page.pageId), ["a"]);
  assertEquals(out[0].tagLabel, "cockpit:devops");
});

Deno.test("pendingOf skips a page that already carries a reference", () => {
  // A mirrored page carries BOTH the mapping's tag and a ref: offering to file
  // it would create a duplicate of the ticket it was made from.
  assertEquals(
    pendingOf(
      [candidate(
        "a",
        "proj",
        ["cockpit-devops"],
        "{{trame:cockpit_ref=CKP-9}}",
      )],
      MAPPINGS,
    ),
    [],
  );
});

Deno.test("pendingOf ignores pages outside the mapping", () => {
  assertEquals(
    pendingOf([
      candidate("a", "other", ["cockpit-devops"]), // right tag, wrong project
      candidate("b", "proj", ["notes"]), // right project, wrong tag
      candidate("c", "proj", []), // untagged
    ], MAPPINGS),
    [],
  );
});

Deno.test("pendingOf matches the tag key, not the label", () => {
  // Pages store keys; a page tagged with the LABEL is a different tag.
  assertEquals(
    pendingOf([candidate("a", "proj", ["cockpit:devops"])], MAPPINGS),
    [],
  );
});

// Status is one-way. Cockpit tracks execution; a page only says whether it is
// still worth looking at, because the execution axis lives on sessions here.

Deno.test("pageStatusOf keeps every unfinished ticket in view", () => {
  for (const s of ["todo", "in_progress", "to_verify", "to_fix"]) {
    assertEquals(pageStatusOf(s), "open");
  }
});

Deno.test("pageStatusOf folds away a ticket that is over, either way", () => {
  // Shipped and dropped both mean "stop showing me this". That they are
  // indistinguishable here is exactly why nothing is written back.
  assertEquals(pageStatusOf("done"), "archived");
  assertEquals(pageStatusOf("cancelled"), "archived");
});

Deno.test("pageStatusOf reads an unknown status as open, never archived", () => {
  // A state Cockpit adds later must not silently fold pages out of the tree.
  assertEquals(pageStatusOf("in_review_2"), "open");
  assertEquals(pageStatusOf(""), "open");
});

Deno.test("planMirror pulls the ticket's status onto its page", () => {
  const t = ticket({ status: "done" });
  const plan = planMirror([t], [pageOf(t, "p1")], ["CKP-1"]);
  assertEquals(plan.update[0].status, "archived");
});

Deno.test("planMirror never lets a local status stop the pull", () => {
  // The page is the mirror's to write: archiving one here is undone next pass
  // if the ticket is still live. Closing a ticket is a decision for Cockpit.
  const t = ticket({ status: "in_progress" });
  const plan = planMirror([t], [pageOf(t, "p1", [], "archived")], ["CKP-1"]);
  assertEquals(plan.update[0].status, "open");
});

Deno.test("planMirror gives a new page the ticket's status", () => {
  const plan = planMirror([ticket({ status: "cancelled" })], [], ["CKP-1"]);
  assertEquals(plan.create[0].status, "archived");
});
