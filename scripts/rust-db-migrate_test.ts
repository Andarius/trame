import { test } from "bun:test";
import { mkdtemp, open as openFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint, requireStopped } from "./rust-db-migrate.ts";

// requireStopped scans /proc, which only Linux has
const linuxOnly = test.skipIf(process.platform !== "linux");

linuxOnly("migration refuses open sources and symlink entries without modifying source", async () => {
  const scratch = new URL("../.scratch/", import.meta.url).pathname;
  const root = await mkdtemp(join(scratch, "migration-safety-"));
  const path = `${root}/PG_VERSION`;
  await writeFile(path, "18\n");
  const original = await fingerprint(root);
  const file = await openFile(path);
  try {
    let refused = false;
    try {
      await requireStopped(root);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("open source accepted");
  } finally {
    await file.close();
  }
  try {
    const child = Bun.spawn(
      [process.execPath, "-e", 'console.log("ready"); setTimeout(() => {}, 60_000);'],
      { env: { ...process.env, TRACKER_DATA_DIR: root }, stdout: "pipe", stderr: "ignore" },
    );
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
      await child.exited;
      await child.stdout.cancel();
    }
    if (await fingerprint(root) !== original) {
      throw new Error("source changed during refusal");
    }
    await symlink(path, `${root}/alias`);
    let refused = false;
    try {
      await fingerprint(root);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("source symlink accepted");
  } finally {
    await rm(root, { recursive: true });
  }
});

linuxOnly("stopped fake postmaster PID and the migrator's own source override are safe", async () => {
  const root = await mkdtemp(join(new URL("../.scratch/", import.meta.url).pathname, "migration-stopped-"));
  const before = process.env.TRACKER_DATA_DIR;
  try {
    await writeFile(`${root}/postmaster.pid`, "0\n");
    process.env.TRACKER_DATA_DIR = root;
    await requireStopped(root);
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    await rm(root, { recursive: true });
  }
});
