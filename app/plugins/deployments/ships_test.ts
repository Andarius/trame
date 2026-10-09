import { assertEquals } from "@std/assert";
import { DEFAULT_RULES, matchCards, refNumbers, ruleFor, sanitizeRules } from "./ships.ts";

const GH = DEFAULT_RULES.github.pattern;
const GL = DEFAULT_RULES.gitlab.pattern;

Deno.test("refNumbers reads every PR/MR reference in a commit message", () => {
  const cases: [string, string, string, number[]][] = [
    ["github backport carries develop + own PR", "[master] fix(ci): retry (#3922) (#3923)", GH, [3922, 3923]],
    ["github squash merge", "feat: checkout revamp (#120)", GH, [120]],
    ["github merge commit", "Merge pull request #57 from acme/feat", GH, [57]],
    [
      "gitlab merge commit body",
      "Merge branch 'chore/x' into 'master'\n\nchore: drop map\n\nSee merge request obitrain/obiapp!200",
      GL,
      [200],
    ],
    ["custom pattern", "PROJ-12: fix login (PR-88)", "PR-(\\d+)", [88]],
    ["no reference", "chore: bump deps", GH, []],
  ];
  for (const [name, message, pattern, want] of cases) assertEquals(refNumbers(message, pattern), want, name);
});

Deno.test("matchCards keeps open cards whose PR/MR ships in the release", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixture.sample.json", import.meta.url)));
  const ghCommits = (fixture.changelogs["https://github.com/acme/webapp/actions/runs/123456789"] as { title: string }[])
    .map((c) => refNumbers(c.title, GH));
  const card = (id: string, pr_url: string | null) => ({ id, title: id, status: "active", pr_url });
  type Want = { pr: number; via: number | null } | null;
  const cases: [string, "github" | "gitlab", number[][], ReturnType<typeof card>, boolean, Want][] = [
    [
      "develop PR of a backport",
      "github",
      ghCommits,
      card("a", "https://github.com/acme/webapp/pull/3928"),
      true,
      { pr: 3928, via: 3931 },
    ],
    [
      "backport rule off",
      "github",
      ghCommits,
      card("a", "https://github.com/acme/webapp/pull/3928"),
      false,
      { pr: 3928, via: null },
    ],
    [
      "one PR among several lines",
      "github",
      ghCommits,
      card("b", "https://github.com/acme/webapp/pull/1\nhttps://github.com/acme/webapp/pull/3931"),
      true,
      { pr: 3931, via: 3928 },
    ],
    ["same number, other repo", "github", ghCommits, card("c", "https://github.com/acme/api/pull/3928"), true, null],
    ["prefix of a shipped number", "github", ghCommits, card("d", "https://github.com/acme/webapp/pull/392"), true, null],
    [
      "gitlab MR",
      "gitlab",
      [[200]],
      card("e", "https://gitlab.com/acme/webapp/-/merge_requests/200"),
      true,
      { pr: 200, via: null },
    ],
    [
      "gitlab MR on another host",
      "gitlab",
      [[200]],
      card("f", "https://git.corp/acme/webapp/-/merge_requests/200"),
      true,
      null,
    ],
    ["no PRs", "github", ghCommits, card("g", null), true, null],
  ];
  for (const [name, forge, commits, c, backport, want] of cases) {
    const [hit] = matchCards(forge, "https://gitlab.com", "acme/webapp", commits, [c], backport);
    assertEquals(hit ? { pr: hit.pr, via: hit.via } : null, want, name);
  }
});

Deno.test("per-repo rules fall back to the forge default and drop bad input", () => {
  const stored = {
    "acme/webapp": { pattern: "PR-(\\d+)", environments: ["production"], backport: false },
    "acme/api": { pattern: "(unclosed" },
  };
  const cases: [string, string, "github" | "gitlab", ReturnType<typeof ruleFor>][] = [
    ["override", "acme/webapp", "github", { pattern: "PR-(\\d+)", environments: ["production"], backport: false }],
    ["invalid pattern → default", "acme/api", "gitlab", DEFAULT_RULES.gitlab],
    ["no rule → default", "acme/other", "github", DEFAULT_RULES.github],
  ];
  for (const [name, repo, forge, want] of cases) assertEquals(ruleFor(stored, repo, forge), want, name);

  // unwatched repos, invalid patterns and patterns without a capture group are dropped
  assertEquals(
    sanitizeRules(
      { ...stored, "evil/unwatched": { backport: false }, "acme/x": { pattern: "no-group" } },
      ["acme/webapp", "acme/api", "acme/x"],
    ),
    { "acme/webapp": stored["acme/webapp"] },
  );
});
