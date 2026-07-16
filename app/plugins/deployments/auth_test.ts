import { assertEquals } from "@std/assert";
import { gitlabAuth } from "./auth.ts";

// Regression: ambient credentials (GITLAB_TOKEN, the glab CLI) are bound to the host the
// user saved. A caller-supplied base URL must not be able to borrow them, or /test would
// hand the env token to whatever host it names.
Deno.test("gitlabAuth never lends ambient creds to a caller-supplied host", async (t) => {
  Deno.env.set("GITLAB_TOKEN", "env-secret");

  await t.step("saved host may use the env token", async () => {
    const a = await gitlabAuth({}, "https://gitlab.com");
    assertEquals(a, { token: "env-secret", source: "env" });
  });

  await t.step("caller-supplied host gets nothing", async () => {
    const a = await gitlabAuth({}, "http://attacker.example", { ambient: false });
    assertEquals(a, { token: "", source: "none" });
  });

  await t.step("caller-supplied host may use an explicitly supplied token", async () => {
    const a = await gitlabAuth({ gitlabToken: "pat-123" }, "http://attacker.example", { ambient: false });
    assertEquals(a, { token: "pat-123", source: "settings" });
  });

  Deno.env.delete("GITLAB_TOKEN");
});
