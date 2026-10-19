import { expect, test } from "bun:test";
import { cloneUrl } from "./clone-url.ts";

test("clone URL from a card's PR link", () => {
  for (
    const [pr, expected] of [
      ["https://github.com/Getsoren/sre-config/pull/933", { url: "git@github.com:Getsoren/sre-config.git", name: "Getsoren/sre-config" }],
      // first of several PRs; GitLab subgroups keep their full path
      [
        "https://gitlab.example.com/obitrain/apps/obiapp/-/merge_requests/12\nhttps://github.com/a/b/pull/1",
        { url: "git@gitlab.example.com:obitrain/apps/obiapp.git", name: "obitrain/apps/obiapp" },
      ],
      ["https://example.com/", null],
      ["not a url", null],
      [null, null],
    ] as const
  ) {
    expect(cloneUrl(pr), String(pr)).toStrictEqual(expected);
  }
});
