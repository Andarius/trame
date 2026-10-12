import { scratchPath } from "./rust-db-export.ts";

Deno.test("export rejects outside paths and symlink escapes before opening a database", async () => {
  const root = new URL("../.scratch/", import.meta.url).pathname;
  const temp = await Deno.makeTempDir({ dir: root, prefix: "db-path-check-" });
  try {
    if (await scratchPath(temp) !== await Deno.realPath(temp)) {
      throw new Error("isolated path rejected");
    }
    await Deno.symlink(Deno.cwd(), `${temp}/escape`);
    for (const path of [Deno.cwd(), `${temp}/escape`, `${temp}/../../`]) {
      let rejected = false;
      try {
        await scratchPath(path);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("unsafe export path accepted");
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
