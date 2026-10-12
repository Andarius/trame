import { fingerprint, requireStopped } from "./rust-db-migrate.ts";

Deno.test("migration refuses open sources and symlink entries without modifying source", async () => {
  const scratch = new URL("../.scratch/", import.meta.url).pathname;
  const root = await Deno.makeTempDir({
    dir: scratch,
    prefix: "migration-safety-",
  });
  const path = `${root}/PG_VERSION`;
  await Deno.writeTextFile(path, "18\n");
  const original = await fingerprint(root);
  const open = await Deno.open(path);
  try {
    let refused = false;
    try {
      await requireStopped(root);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("open source accepted");
  } finally {
    open.close();
  }
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        'console.log("ready"); await new Promise((resolve) => setTimeout(resolve, 60_000));',
      ],
      env: { TRACKER_DATA_DIR: root },
      stdout: "piped",
      stderr: "null",
    }).spawn();
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      let refused = false;
      try {
        await requireStopped(root);
      } catch {
        refused = true;
      }
      if (!refused) {
        throw new Error("configured source with closed files accepted");
      }
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await child.stdout.cancel();
    }
    if (await fingerprint(root) !== original) {
      throw new Error("source changed during refusal");
    }
    await Deno.symlink(path, `${root}/alias`);
    let refused = false;
    try {
      await fingerprint(root);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("source symlink accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stopped fake postmaster PID and the migrator's own source override are safe", async () => {
  const root = await Deno.makeTempDir({
    dir: new URL("../.scratch/", import.meta.url).pathname,
    prefix: "migration-stopped-",
  });
  const before = Deno.env.get("TRACKER_DATA_DIR");
  try {
    await Deno.writeTextFile(`${root}/postmaster.pid`, "0\n");
    Deno.env.set("TRACKER_DATA_DIR", root);
    await requireStopped(root);
  } finally {
    if (before === undefined) Deno.env.delete("TRACKER_DATA_DIR");
    else Deno.env.set("TRACKER_DATA_DIR", before);
    await Deno.remove(root, { recursive: true });
  }
});
