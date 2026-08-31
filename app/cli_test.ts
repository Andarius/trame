import { assertEquals, assertStringIncludes } from "@std/assert";
import { boardRows, formatBoard, run } from "../track/cli.ts";
import { ensureOnPath, EMBEDS, setup } from "../track/setup.ts";
import {
  COMMENT_HELP,
  OVERVIEW,
  PAGE_DIALECT,
  PAGE_HELP,
  TRACK_HELP,
  VERSION,
} from "../track/help.ts";

Deno.test("cli version is the package version, stamped with the build when compiled", async () => {
  const { version } = JSON.parse(
    await Deno.readTextFile(new URL("./deno.json", import.meta.url)),
  );
  const stamp = Deno.env.get("TRAME_BUILD"); // baked in by scripts/build-cli.ts
  assertEquals(VERSION, stamp ? `${version}+${stamp}` : version);
});

// the help text IS the agent contract — a refactor must not drop the conventions
Deno.test("help carries the composition conventions", () => {
  assertStringIncludes(TRACK_HELP, "outcome first");
  assertStringIncludes(TRACK_HELP, "upserts by repo_path+branch");
  assertStringIncludes(TRACK_HELP, "specs_page_id");
  assertStringIncludes(TRACK_HELP, "do not ask the user");
  assertStringIncludes(PAGE_HELP, "{{fold}}");
  assertStringIncludes(PAGE_DIALECT, "green|yellow|red|copper|gray");
  assertStringIncludes(COMMENT_HELP, "meta.model is required");
  for (const cmd of ["track", "page", "comment", "watch", "list"]) {
    assertStringIncludes(OVERVIEW, `\n  ${cmd}`);
  }
});

Deno.test("dispatch: help and version exit 0, unknown command exits 2", async () => {
  assertEquals(await run([]), 0);
  assertEquals(await run(["--version"]), 0);
  assertEquals(await run(["help", "track"]), 0);
  assertEquals(await run(["track", "--help"]), 0);
  assertEquals(await run(["bogus"]), 2);
});

Deno.test("formatBoard groups open sessions by story and hides terminal columns", () => {
  const board = {
    sessions: [
      {
        id: "s1",
        title: "repo — fix thing",
        status: "active",
        branch: "fix/thing",
        next_step: "merge it",
        pr_url: null,
        page_id: "st-1",
        deleted: false,
      },
      {
        id: "s2",
        title: "repo — old work",
        status: "done",
        branch: null,
        next_step: null,
        pr_url: null,
        page_id: "st-1",
        deleted: false,
      },
      {
        id: "s3",
        title: "repo — orphan",
        status: "paused",
        branch: null,
        next_step: null,
        pr_url: null,
        page_id: null,
        deleted: false,
      },
      {
        id: "s4",
        title: "repo — gone",
        status: "active",
        branch: null,
        next_step: null,
        pr_url: null,
        page_id: null,
        deleted: true,
      },
    ],
    stories: [{ id: "st-1", title: "Ship the thing" }],
    statuses: [
      { key: "active", terminal: false },
      { key: "paused", terminal: false },
      { key: "done", terminal: true },
    ],
  };
  const out = formatBoard(board);
  assertStringIncludes(
    out,
    "Ship the thing\n  [active] repo — fix thing (fix/thing) — next: merge it",
  );
  assertStringIncludes(out, "(no story)\n  [paused] repo — orphan");
  assertEquals(out.includes("old work"), false);
  assertEquals(out.includes("gone"), false);
});

Deno.test("formatBoard with nothing open", () => {
  assertEquals(
    formatBoard({ sessions: [], stories: [], statuses: [] }),
    "no open sessions",
  );
});

Deno.test("boardRows flattens open sessions for --json", () => {
  const rows = boardRows({
    sessions: [
      {
        id: "s1",
        title: "repo — fix thing",
        status: "active",
        branch: "fix/thing",
        next_step: "merge it",
        pr_url: null,
        page_id: "st-1",
        deleted: false,
      },
      {
        id: "s2",
        title: "repo — done work",
        status: "done",
        branch: null,
        next_step: null,
        pr_url: null,
        page_id: null,
        deleted: false,
      },
    ],
    stories: [{ id: "st-1", title: "Ship the thing" }],
    statuses: [
      { key: "active", terminal: false },
      { key: "done", terminal: true },
    ],
  });
  assertEquals(rows, [{
    id: "s1",
    title: "repo — fix thing",
    status: "active",
    story: "Ship the thing",
    branch: "fix/thing",
    next_step: "merge it",
    pr_url: null,
  }]);
});

// Regression: setup used to skip linking whenever SOME `tramecli` answered, so a
// stale copy kept serving old code behind freshly installed docs.
Deno.test("setup relinks tramecli at this build, and flags one shadowing it", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "trame-onpath-test-" });
  const path = Deno.env.get("PATH") ?? "";
  try {
    const home = `${tmp}/home`;
    const self = `${tmp}/build/tramecli`;
    await Deno.mkdir(`${tmp}/build`, { recursive: true });
    await Deno.mkdir(`${home}/.local/bin`, { recursive: true });
    await Deno.writeTextFile(self, "#!/bin/sh\n", { mode: 0o755 });
    // the stale copy this fix is about: on PATH, answering to the name, months old
    await Deno.writeTextFile(`${home}/.local/bin/tramecli`, "old build", {
      mode: 0o755,
    });
    const sys = "/usr/bin:/bin"; // `which` lives there; the real ~/.local/bin must not
    Deno.env.set("PATH", `${home}/.local/bin:${sys}`);

    assertEquals(await ensureOnPath(home, self), null, "no warning");
    const dest = `${home}/.local/bin/tramecli`;
    assertEquals((await Deno.lstat(dest)).isSymlink, true, "copy → symlink");
    assertEquals(await Deno.realPath(dest), await Deno.realPath(self));
    assertEquals(await ensureOnPath(home, self), null, "idempotent");

    // another tramecli earlier on PATH wins the name — say so instead of lying
    await Deno.mkdir(`${tmp}/shadow`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/shadow/tramecli`, "other", { mode: 0o755 });
    Deno.env.set("PATH", `${tmp}/shadow:${home}/.local/bin:${sys}`);
    assertStringIncludes(
      await ensureOnPath(home, self) ?? "",
      `${tmp}/shadow/tramecli`,
    );
  } finally {
    Deno.env.set("PATH", path);
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setup embeds call the bare binary and install everywhere", async () => {
  for (const [name, text] of Object.entries(EMBEDS)) {
    for (
      const legacy of [
        "__TRAMECLI__",
        "__TRACK_WRITER__",
        "__PAGE_WRITER__",
        "__PAGE_WATCH__",
      ]
    ) {
      assertEquals(text.includes(legacy), false, `${name}: ${legacy}`);
    }
  }
  const home = await Deno.makeTempDir();
  try {
    await setup({ claude: true, skillDirs: [`${home}/.agents/skills`], home });
    for (
      const f of [
        `${home}/.claude/commands/trame/track.md`,
        `${home}/.claude/commands/trame/watch.md`,
        `${home}/.claude/skills/trame-page/SKILL.md`,
        `${home}/.agents/skills/trame-track/SKILL.md`,
        `${home}/.agents/skills/trame-track/agents/openai.yaml`,
        `${home}/.agents/skills/trame-page/SKILL.md`,
      ]
    ) {
      await Deno.stat(f);
    }
    assertStringIncludes(
      await Deno.readTextFile(`${home}/.claude/commands/trame/track.md`),
      "tramecli track --help",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
