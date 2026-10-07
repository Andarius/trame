import { assertEquals } from "@std/assert";
import { splitTagLabel, TAG_COLORS, tagColor } from "../core/tags.ts";

Deno.test("splitTagLabel only splits a real namespace", async (t) => {
  const cases: [string, string, { ns: string | null; value: string }][] = [
    ["namespaced", "team:devops", { ns: "team", value: "devops" }],
    ["plain", "infra", { ns: null, value: "infra" }],
    ["spaced around the colon", "team : devops", {
      ns: "team",
      value: "devops",
    }],
    // A colon at either end has nothing on one side — splitting would render a
    // half-empty pill, so the label stays whole.
    ["leading colon", ":devops", { ns: null, value: ":devops" }],
    ["trailing colon", "team:", { ns: null, value: "team:" }],
    // Only the first colon counts: the rest belongs to the value.
    ["two colons", "a:b:c", { ns: "a", value: "b:c" }],
  ];
  for (const [name, label, want] of cases) {
    await t.step(name, () => assertEquals(splitTagLabel(label), want));
  }
});

Deno.test("tagColor is stable per key and stays in the palette", () => {
  assertEquals(tagColor("team-devops"), tagColor("team-devops"));
  for (const key of ["a", "infra", "team-devops", "", "zzz-9"]) {
    assertEquals(TAG_COLORS.includes(tagColor(key) as never), true);
  }
});
