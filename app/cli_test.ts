import { assertEquals, assertStringIncludes } from "@std/assert";
import { boardRows, formatBoard, run } from "../track/cli.ts";
import { EMBEDS, setup } from "../track/setup.ts";
import {
  COMMENT_HELP,
  OVERVIEW,
  PAGE_DIALECT,
  PAGE_HELP,
  TRACK_HELP,
  VERSION,
} from "../track/help.ts";

Deno.test("cli version matches app/deno.json", async () => {
  const { version } = JSON.parse(
    await Deno.readTextFile(new URL("./deno.json", import.meta.url)),
  );
  assertEquals(VERSION, version);
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

Deno.test("setup embeds carry the placeholder and stamp it away", async () => {
  for (const [name, text] of Object.entries(EMBEDS)) {
    if (name !== "trackSkillOpenai") {
      assertStringIncludes(text, "__TRAMECLI__");
    }
    assertEquals(text.includes("__TRACK_WRITER__"), false, name);
    assertEquals(text.includes("__PAGE_WRITER__"), false, name);
    assertEquals(text.includes("__PAGE_WATCH__"), false, name);
  }
  const home = await Deno.makeTempDir();
  try {
    await setup({
      claude: true,
      skillDirs: [`${home}/.agents/skills`],
      home,
      invocation: "tramecli",
    });
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
      const text = await Deno.readTextFile(f);
      assertEquals(text.includes("__TRAMECLI__"), false, f);
    }
    assertStringIncludes(
      await Deno.readTextFile(`${home}/.claude/commands/trame/track.md`),
      "tramecli track --help",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
