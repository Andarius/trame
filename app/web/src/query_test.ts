import { assertEquals } from "@std/assert";
import { filterSessions, matchQuery, needsAssigners, parseQuery } from "./query.ts";

const now = Date.parse("2026-09-25T12:00:00Z");
const item: Record<string, string[]> = {
  "": ["fix topbar", "feat/topbar-query"],
  status: ["blocked"],
  tag: ["p1", "ui"],
  branch: ["feat/topbar-query"],
  touched: ["2026-09-24T10:00:00.000Z"],
  has: ["branch", "pr"],
};
const matches = (q: string) => matchQuery(parseQuery(q).terms, (k) => item[k ?? ""] ?? [], now);

for (
  const [q, want] of [
    ["", true],
    ["topbar", true],
    ["TOPBAR status:blocked", true],
    ["status:active,blocked", true],
    ["status:block", false], // exact key: no substring
    ["-status:blocked", false],
    ["tag:p1 -tag:p10", true],
    ['"fix top"', true],
    ["branch:feat/*", true],
    ["branch:main*", false],
    ["has:pr no:specs", true],
    ["no:pr", false],
    ["touched:>2d", true],
    ["touched:<2026-09-24", false],
    ["touched:>=2026-09-24", true],
  ] as const
) {
  Deno.test(`matchQuery: ${q || "(empty)"}`, () => assertEquals(matches(q), want));
}

Deno.test("parseQuery: flags unknown keys", () => {
  assertEquals(parseQuery("colour:red topbar").errors, ['unknown key "colour"']);
});

const board = {
  pages: [
    { id: "pr", parent_id: null, kind: "project", title: "Trame", icon: null },
    { id: "st", parent_id: "pr", kind: "story", title: "CLI rollout", icon: null, tags: ["p1"] },
    { id: "sp", parent_id: "st", kind: "page", title: "Specs", icon: null },
  ],
  statuses: [{ key: "active", label: "In progress" }],
  projects: [],
};
const base = {
  status: "active", client_id: null, next_step: null, branch: null, repo_path: null, pr_url: null,
  last_touched: "2026-09-24T10:00:00.000Z",
};
const sessions = [
  { ...base, id: "s1", title: "under story", page_id: "sp", specs_page_id: "sp" },
  { ...base, id: "s2", title: "loose", page_id: null, specs_page_id: "gone" },
];
// only s1 has a face: s2 is a card nobody handed me
const assigners = { s1: { name: "Carlo Rossi" } };
for (
  const [q, want] of [
    ["story:cli", ["under story"]],
    ["project:trame tag:p1", ["under story"]], // project/tags inherited through the tree
    ['status:"in progress" no:specs', ["loose"]], // status label; a deleted specs page is no specs
    ["-has:story", ["loose"]],
    ["assigner:carlo", ["under story"]],
    ["assigner:ROSSI", ["under story"]], // substring, case-insensitive
    ["-assigner:carlo", ["loose"]],
    ["assigner:nobody", []],
    ["has:assigner", ["under story"]],
    ["no:assigner", ["loose"]],
    ["-assigner:nobody", ["under story", "loose"]],
  ] as const
) {
  Deno.test(`filterSessions: ${q}`, () =>
    assertEquals(filterSessions(sessions, board, q, assigners).map((s) => s.title), [...want]));
}

for (
  const [q, want] of [
    ["assigner:carlo", true],
    ["-has:assigner", true],
    ["no:assigner", true],
    ["has:assigners", false],
    ["title:assigner", false],
  ] as const
) {
  Deno.test(`needsAssigners: ${q}`, () => assertEquals(needsAssigners(parseQuery(q).terms), want));
}
