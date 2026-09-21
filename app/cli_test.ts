import { testTempDir } from "./test_tmp.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { boardRows, formatBoard, run, staleWarning } from "../track/cli.ts";
import { ensureOnPath, EMBEDS, installHook, setup } from "../track/setup.ts";
import {
  COMMENT_HELP,
  CONVERT_HELP,
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
  assertStringIncludes(PAGE_DIALECT, "`cards` fence");
  assertStringIncludes(COMMENT_HELP, "meta.model is required");
  assertStringIncludes(CONVERT_HELP, "specs_page_id");
  for (const cmd of ["track", "page", "comment", "watch", "list", "convert"]) {
    assertStringIncludes(OVERVIEW, `\n  ${cmd}`);
  }
});

Deno.test("dispatch: help and version exit 0, unknown command exits 2", async () => {
  assertEquals(await run([]), 0);
  assertEquals(await run(["--version"]), 0);
  assertEquals(await run(["help", "track"]), 0);
  assertEquals(await run(["track", "--help"]), 0);
  assertEquals(await run(["convert", "--help"]), 0);
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:42:40.564Z",
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:42:40.564Z",
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:00:00.000Z",
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:00:00.000Z",
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:42:40.564Z",
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
        repo_path: "/home/dev/repo",
        last_touched: "2026-09-09T18:00:00.000Z",
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
    // the pre-push hook matches on these two and compares the stamp to the commit
    repo_path: "/home/dev/repo",
    last_touched: "2026-09-09T18:42:40.564Z",
    next_step: "merge it",
    pr_url: null,
  }]);
});

// Regression: setup used to skip linking whenever SOME `tramecli` answered, so a
// stale copy kept serving old code behind freshly installed docs.
Deno.test("setup relinks tramecli at this build, and flags one shadowing it", async () => {
  const tmp = testTempDir("trame-onpath-test-");
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
  const home = testTempDir("trame-test-");
  try {
    await setup({ claude: true, skillDirs: [`${home}/.agents/skills`], home });
    for (
      const f of [
        `${home}/.claude/skills/trame-track/SKILL.md`,
        `${home}/.claude/skills/trame-page/SKILL.md`,
        `${home}/.claude/skills/trame-watch/SKILL.md`,
        `${home}/.agents/skills/trame-track/SKILL.md`,
        `${home}/.agents/skills/trame-track/agents/openai.yaml`,
        `${home}/.agents/skills/trame-page/SKILL.md`,
        `${home}/.agents/skills/trame-watch/SKILL.md`,
      ]
    ) {
      await Deno.stat(f);
    }
    assertStringIncludes(
      await Deno.readTextFile(`${home}/.claude/skills/trame-track/SKILL.md`),
      "tramecli track --help",
    );
    // a legacy slash-command install is cleaned up
    await Deno.mkdir(`${home}/.claude/commands/trame`, { recursive: true });
    await Deno.writeTextFile(`${home}/.claude/commands/trame/track.md`, "old");
    await setup({ claude: true, skillDirs: [], home });
    assertEquals(
      await Deno.stat(`${home}/.claude/commands/trame`).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

// The guard only runs if git finds it: `core.hooksPath` moves the directory, and a
// hook we did not write must survive us.
Deno.test("setup --hook writes the pre-push guard where git looks for it", async () => {
  const tmp = testTempDir("trame-hook-test-");
  const git = (args: string[], cwd = tmp) =>
    new Deno.Command("git", { args, cwd, stdout: "null", stderr: "null" }).output();
  await git(["init", "-q"]);

  const path = await installHook(tmp);
  assertEquals(path, `${tmp}/.git/hooks/pre-push`);
  assertStringIncludes(await Deno.readTextFile(path), "tramecli list --json");
  assertEquals((await Deno.stat(path)).mode! & 0o111, 0o111, "executable");
  assertEquals(await installHook(tmp), path, "idempotent");

  await Deno.mkdir(`${tmp}/.githooks`, { recursive: true });
  await git(["config", "core.hooksPath", ".githooks"]);
  assertEquals(await installHook(tmp), `${tmp}/.githooks/pre-push`);

  await Deno.writeTextFile(`${tmp}/.githooks/pre-push`, "#!/bin/sh\nsomeone else\n");
  await assertRejects(() => installHook(tmp), Error, "not ours");
});

// `just setup` only exists in a checkout — an installed CLI is replaced from the
// release page, so the advice has to follow the binary.
Deno.test("staleWarning fires only on a mismatch, and points at the right install", () => {
  const cases: [string, string | undefined, string, string | null][] = [
    ["0.13.0", "0.13.0", "/home/x/.local/bin/tramecli", null],
    ["0.13.0+abc123", "0.13.0", "/home/x/.local/bin/tramecli", null], // build stamp is not skew
    ["0.13.0", undefined, "/home/x/.local/bin/tramecli", null],
    ["0.14.0", "0.13.0", "/home/x/.local/bin/tramecli", null], // dev build ahead: not news
    ["0.13.0", "0.14.0", "/home/x/.local/bin/tramecli", "releases/latest"],
    ["0.13.0", "0.14.0", "/home/x/trame/dist/tramecli", "`just setup`"],
    ["0.13.0", "0.14.0", "/home/x/.local/bin/tramecli", "a new tramecli is available"],
  ];
  for (const [cli, app, execPath, want] of cases) {
    const line = staleWarning(cli, app, execPath);
    if (want === null) assertEquals(line, null, `${cli} vs ${app}`);
    else assertStringIncludes(line ?? "", want);
  }
});
