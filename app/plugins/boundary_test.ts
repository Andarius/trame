import { assertEquals } from "@std/assert";

// Cockpit is headed for its own repo: it may reach Trame only through "@trame/plugin-api"
// (tests: "@trame/plugin-test"), so the move is a copy, not a rewrite.
Deno.test("the cockpit plugin imports Trame only through the plugin API", async () => {
  const dir = new URL("./cockpit/", import.meta.url);
  const bad: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(new URL(e.name, dir));
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
      ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
    ];
    for (const [, spec] of specs) {
      const ok = spec.startsWith("./") || /^(@std\/|jsr:|npm:)/.test(spec) || spec === "@trame/plugin-api" ||
        (spec === "@trame/plugin-test" && e.name.endsWith("_test.ts"));
      if (!ok) bad.push(`${e.name}: ${spec}`);
    }
  }
  assertEquals(bad, []);
});
