import { assertEquals } from "@std/assert";
import {
  applySuggestion,
  filterSessions,
  matchQuery,
  needsAssigners,
  parseQuery,
  queryValues,
  suggestQuery,
} from "./query.ts";

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
    ["topbar status:", true], // a key still being typed filters nothing
    ["-status:", true],
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

const values = {
  status: [{ value: "active", hint: "In progress" }, { value: "blocked" }, { value: "paused" }],
  story: [{ value: "CLI rollout" }],
  has: [{ value: "pr" }, { value: "specs" }],
};
// "|" marks the caret; want = the labels offered, then the query after taking the first one
for (
  const [q, labels, applied] of [
    ["st|", ["status:", "story:"], "status:|"],
    ["-st|", ["status:", "story:"], "-status:|"],
    ["tag:p1 ST|", ["status:", "story:"], "tag:p1 status:|"],
    ["status:|", ["active", "blocked", "paused"], "status:active |"],
    ["status:a|", ["active", "paused"], "status:active |"], // prefix first, then substring
    ["status:active,b|", ["blocked"], "status:active,blocked |"],
    ["story:cli|", ["CLI rollout"], 'story:"CLI rollout" |'],
    ['story:"cl|', ["CLI rollout"], 'story:"CLI rollout" |'],
    ["no:s|", ["specs"], "no:specs |"],
    ["status:a| tag:p1", ["active", "paused"], "status:active |tag:p1"], // reuses the existing space
    ["st|atus:active", [], null], // caret mid-word
    ["|", [], null],
    ["zz|", [], null],
    ["repo:|", [], null], // free-text key: nothing to propose
    ['"fix top|', [], null],
  ] as const
) {
  Deno.test(`suggestQuery: ${q}`, () => {
    const cursor = q.indexOf("|"), text = q.replace("|", "");
    const got = suggestQuery(text, cursor, values);
    assertEquals(got.map((s) => s.label), [...labels]);
    if (applied) {
      const next = applySuggestion(text, got[0]);
      assertEquals(next.query.slice(0, next.cursor) + "|" + next.query.slice(next.cursor), applied);
    }
  });
}

Deno.test("queryValues: reads the board and the assigners", () => {
  const got = queryValues({ ...board, sessions: [{ ...sessions[0], agent: "codex" }, sessions[1]] }, assigners);
  assertEquals(
    [got.status, got.story, got.tag, got.agent, got.assigner],
    [
      [{ value: "active", hint: "In progress" }],
      [{ value: "CLI rollout", icon: null, color: null }],
      [{ value: "p1" }],
      [{ value: "codex" }],
      [{ value: "Carlo Rossi", avatar: null }],
    ],
  );
});

Deno.test("queryValues: one assigner row per person, with a picture when any card has one", () => {
  const faces = { a: { name: "Carlo Rossi" }, b: { name: "Carlo Rossi", avatar: "c.png" }, c: { name: "Ana" } };
  const got = queryValues({ ...board, sessions: [] }, faces);
  assertEquals(got.assigner, [{ value: "Ana", avatar: null }, { value: "Carlo Rossi", avatar: "c.png" }]);
  assertEquals(suggestQuery("assigner:car", 12, got).map((s) => [s.label, s.value?.avatar]), [["Carlo Rossi", "c.png"]]);
});

Deno.test("queryValues: projects and stories carry their icon and color", () => {
  const got = queryValues({
    ...board,
    sessions,
    pages: board.pages.map((p) => p.id === "st" ? { ...p, icon: "🧪" } : p),
    projects: [{ id: "pr", name: "Trame", icon: "🚂", color: "#f00" }],
  });
  assertEquals([got.project, got.story], [
    [{ value: "Trame", icon: "🚂", color: "#f00" }],
    [{ value: "CLI rollout", icon: "🧪", color: null }],
  ]);
  assertEquals(suggestQuery("project:tr", 10, got).map((s) => [s.key, s.value]), [["project", got.project[0]]]);
});
