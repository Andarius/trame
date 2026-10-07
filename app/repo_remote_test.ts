import { assertEquals } from "@std/assert";
import { remoteToWeb } from "./repo_remote.ts";

Deno.test("remoteToWeb turns any origin spelling into the repo's web page", async (t) => {
  for (
    const [id, remote, web] of [
      ["scp-style ssh", "git@github.com:Getsoren/sre-config.git", "https://github.com/Getsoren/sre-config"],
      ["ssh url with port", "ssh://git@gitlab.com:22/obitrain/obi-chart.git", "https://gitlab.com/obitrain/obi-chart"],
      ["https with token", "https://x-token:abc@github.com/Andarius/trame.git\n", "https://github.com/Andarius/trame"],
      ["gitlab subgroup", "git@gitlab.com:obitrain/devops/templates.git", "https://gitlab.com/obitrain/devops/templates"],
      ["local path", "/srv/git/repo.git", null],
    ] as const
  ) {
    await t.step(id, () => assertEquals(remoteToWeb(remote), web));
  }
});
