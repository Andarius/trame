Deno.env.set(
  "TRACKER_CLIENTS",
  '{"Obitrain":"Obitrain","Work":"Soren"}',
);
Deno.env.set("TRACKER_DATA_DIR", "/tmp/client-map-test-unused");
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";

const { clientFor } = await import("./claude-import.ts");

Deno.test("clientFor maps path segments, aliases included", () => {
  assertEquals(clientFor("/home/me/Projects/Obitrain/obiapp"), "Obitrain");
  assertEquals(clientFor("/home/me/Projects/Work/sre-config"), "Soren");
  assertEquals(clientFor("/home/me/Projects/trame"), "Side-projects");
});

Deno.test("clientFor matches dash-encoded scratchpad worktrees", () => {
  assertEquals(
    clientFor("/tmp/claude-1000/-home-me-Projects-Work-sops/abc/scratchpad/wt-x"),
    "Soren",
  );
  // the dashed rule stays scoped to /tmp/claude-…: a real path with a dashed
  // name must not alias ("/data/my-Work-notes" is not Soren's)
  assertEquals(clientFor("/data/my-Work-notes"), "Side-projects");
});
