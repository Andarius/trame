import { assertEquals } from "@std/assert";
import { splitTagLabel, TAG_COLORS, tagColor } from "./tags.ts";

Deno.test("splitTagLabel only splits a real namespace", async (t) => {
  const cases: [string, string, { ns: string | null; value: string }][] = [
    ["namespaced", "cockpit:devops", { ns: "cockpit", value: "devops" }],
    ["plain", "infra", { ns: null, value: "infra" }],
    ["spaced around the colon", "cockpit : devops", {
      ns: "cockpit",
      value: "devops",
    }],
    // A colon at either end has nothing on one side — splitting would render a
    // half-empty pill, so the label stays whole.
    ["leading colon", ":devops", { ns: null, value: ":devops" }],
    ["trailing colon", "cockpit:", { ns: null, value: "cockpit:" }],
    // Only the first colon counts: the rest belongs to the value.
    ["two colons", "a:b:c", { ns: "a", value: "b:c" }],
  ];
  for (const [name, label, want] of cases) {
    await t.step(name, () => assertEquals(splitTagLabel(label), want));
  }
});

Deno.test("tagColor is stable per key and stays in the palette", () => {
  assertEquals(tagColor("cockpit-devops"), tagColor("cockpit-devops"));
  for (const key of ["a", "infra", "cockpit-devops", "", "zzz-9"]) {
    assertEquals(TAG_COLORS.includes(tagColor(key) as never), true);
  }
});
