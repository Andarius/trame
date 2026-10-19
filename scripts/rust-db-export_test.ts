import { test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { scratchPath } from "./rust-db-export.ts";

test("export rejects outside paths and symlink escapes before opening a database", async () => {
  const root = new URL("../.scratch/", import.meta.url).pathname;
  const temp = await mkdtemp(join(root, "db-path-check-"));
  try {
    if (await scratchPath(temp) !== await realpath(temp)) {
      throw new Error("isolated path rejected");
    }
    await symlink(process.cwd(), `${temp}/escape`);
    for (const path of [process.cwd(), `${temp}/escape`, `${temp}/../../`]) {
      let rejected = false;
      try {
        await scratchPath(path);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("unsafe export path accepted");
    }
  } finally {
    await rm(temp, { recursive: true });
  }
});
