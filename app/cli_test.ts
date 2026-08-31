import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatBoard, run } from "../track/cli.ts";
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
        title: "repo — fix thing",
        status: "active",
        branch: "fix/thing",
        next_step: "merge it",
        page_id: "st-1",
        deleted: false,
      },
      {
        title: "repo — old work",
        status: "done",
        branch: null,
        next_step: null,
        page_id: "st-1",
        deleted: false,
      },
      {
        title: "repo — orphan",
        status: "paused",
        branch: null,
        next_step: null,
        page_id: null,
        deleted: false,
      },
      {
        title: "repo — gone",
        status: "active",
        branch: null,
        next_step: null,
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
