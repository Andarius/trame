import { describe, expect, test } from "bun:test";
import { splitTagLabel, TAG_COLORS, tagColor } from "../core/tags.ts";

describe("splitTagLabel only splits a real namespace", () => {
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
    test(name, () => expect(splitTagLabel(label)).toStrictEqual(want));
  }
});

test("tagColor is stable per key and stays in the palette", () => {
  expect(tagColor("team-devops")).toStrictEqual(tagColor("team-devops"));
  for (const key of ["a", "infra", "team-devops", "", "zzz-9"]) {
    expect(TAG_COLORS.includes(tagColor(key) as never)).toStrictEqual(true);
  }
});
