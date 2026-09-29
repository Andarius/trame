import { assert } from "@std/assert";
import {
  similarStories,
  STORY_REUSE,
  STORY_SUGGEST,
  storySimilarity,
} from "../core/story-match.ts";

// Real story titles from the Soren board (2026-09-29).
Deno.test("story similarity bands", async (t) => {
  const cases: [string, string, string, (score: number) => boolean][] = [
    [
      "same topic, reworded",
      "staging cutover saas-dev",
      "Staging cutover (saas-ops → saas-dev)",
      (x) => x >= STORY_REUSE,
    ],
    [
      "accents and punctuation",
      "CI sur la capacité dev",
      "CI sur la capacite dev",
      (x) => x >= STORY_REUSE,
    ],
    [
      "related, suggest only",
      "CI sur la capacite dev (roadmap 7)",
      "Migration Soren — étape 7 : CI sur la capacité dev",
      (x) => x >= STORY_SUGGEST && x < STORY_REUSE,
    ],
    ["ticket id ignored", "GEN-7145 — Soren infra", "Soren infra", (x) => x >= STORY_REUSE],
    ["distinct migrations, suggest only", "Migration Matrix vers soren-prod", "Migration soren-dev", (x) => x < STORY_REUSE],
    [
      "unrelated",
      "Monitoring",
      "Alerting configuration",
      (x) => x < STORY_SUGGEST,
    ],
  ];
  for (const [name, a, b, ok] of cases) {
    await t.step(name, () => {
      const score = storySimilarity(a, b);
      assert(ok(score), `${a} ~ ${b} = ${score}`);
    });
  }
});

Deno.test("similarStories ranks above the floor, best first", () => {
  const hits = similarStories("soren-dev cutover", [
    { id: "1", title: "Monitoring" },
    { id: "2", title: "Migration soren-dev" },
    { id: "3", title: "soren-dev cutover plan" },
  ]);
  assert(hits.map((h) => h.id).join() === "3,2", JSON.stringify(hits));
});
