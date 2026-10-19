// DESCRIPTION: Snapshot a stopped scratch PGlite source; export only a disposable copy.
// USAGE: bun scripts/rust-db-migrate.ts <fingerprint|prepare> <source> [staging]
import { mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { scratchPath, exportPglite } from "./rust-db-export.ts";

export async function requireStopped(source: string): Promise<void> {
  const uid = process.getuid!();
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const proc = `/proc/${pid}`;
    try {
      if ((await stat(proc)).uid !== uid) continue;
      const environment = await readFile(`${proc}/environ`, "utf8").catch((error) => {
        if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return "";
        throw error;
      });
      const command = await readFile(`${proc}/cmdline`, "utf8");
      const args = command.split("\0");
      const migrating = Number(pid) === process.pid ||
        (Number(pid) === process.ppid &&
          (args[1] === "migrate" ||
            process.env.TRAME_MIGRATION_PARENT_PID === pid));
      const configured = environment.split("\0").filter((item) =>
        /^(TRACKER_DATA_DIR|PGLITE_DIR|PGLITE_DATA_DIR)=/.test(item)
      ).map((item) => item.slice(item.indexOf("=") + 1));
      for (const value of [...(migrating ? [] : configured), ...(migrating ? [] : args)]) {
        if (!value.startsWith("/")) continue;
        if (value === source || value.startsWith(`${source}/`)) {
          throw new Error(`source is configured in process ${pid}; stop it before migration`);
        }
        const utf8 = new TextEncoder();
        if (utf8.encode(value).length >= 4096 || value.split("/").some((part) => utf8.encode(part).length > 255)) continue;
        let resolved: string;
        try {
          resolved = await realpath(value);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as NodeJS.ErrnoException).code === "ENOTDIR"
          ) continue;
          throw error;
        }
        if (resolved === source || resolved.startsWith(`${source}/`)) {
          throw new Error(
            `source is configured in process ${pid}; stop it before migration`,
          );
        }
      }
      for (const fd of await readdir(`${proc}/fd`)) {
        let path: string;
        try {
          path = await readlink(`${proc}/fd/${fd}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
        if (path === source || path.startsWith(`${source}/`)) {
          throw new Error(
            `source is open in process ${pid}; stop it before migration`,
          );
        }
      }
      const maps = await readFile(`${proc}/maps`, "utf8").catch((error) => {
        if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return "";
        throw error;
      });
      if (maps.includes(`${source}/`)) {
        throw new Error(`source is mapped in process ${pid}`);
      }
    } catch (error) {
      // Protected process handles are opaque; fingerprints still bracket the copy.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  try {
    const pid = Number(
      (await readFile(`${source}/postmaster.pid`, "utf8")).split("\n")[0],
    );
    if (!Number.isInteger(pid)) {
      throw new Error("invalid source postmaster.pid");
    }
    if (pid > 0) {
      try {
        await stat(`/proc/${pid}`);
        throw new Error("source postmaster is running");
      } catch (error) {
        if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
  } catch (error) {
    if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
}

async function tree(
  source: string,
  destination?: string,
): Promise<[string, string][]> {
  const files: [string, string][] = [];
  async function visit(relative: string) {
    const entries = await readdir(`${source}/${relative}`, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`source symlinks are forbidden: ${path}`);
      }
      if (entry.isDirectory()) {
        if (destination) {
          await mkdir(`${destination}/${path}`, { mode: 0o700 });
        }
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(`${source}/${path}`);
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        files.push([
          path,
          Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(""),
        ]);
        if (destination) {
          await writeFile(`${destination}/${path}`, bytes, {
            mode: 0o600,
          });
        }
      } else throw new Error(`unsupported source entry: ${path}`);
    }
  }
  await visit("");
  return files;
}

export async function fingerprint(source: string): Promise<string> {
  await requireStopped(source);
  const files = await tree(source);
  await requireStopped(source);
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(files)),
    ),
  );
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (import.meta.main) {
  const [mode, input, output] = process.argv.slice(2);
  const source = await scratchPath(input);
  if ((await readFile(`${source}/PG_VERSION`, "utf8")).trim() !== "18") {
    throw new Error("source must be PostgreSQL18");
  }
  if (mode === "fingerprint") {
    console.log(await fingerprint(source));
  } else if (mode === "prepare" && output) {
    const staging = await scratchPath(output);
    if (staging.startsWith(`${source}/`) || source.startsWith(`${staging}/`)) {
      throw new Error("source and staging must be separate");
    }
    const before = await fingerprint(source);
    for (const directory of ["backup", "workcopy", "export"]) {
      await mkdir(`${staging}/${directory}`, { mode: 0o700 });
    }
    await tree(source, `${staging}/backup`);
    if (
      await fingerprint(source) !== before ||
      await fingerprint(`${staging}/backup`) !== before
    ) throw new Error("source changed while snapshotting");
    await tree(`${staging}/backup`, `${staging}/workcopy`);
    await writeFile(`${staging}/source.json`, JSON.stringify({ source, sha256: before }), { mode: 0o600 });
    await exportPglite(`${staging}/workcopy`, `${staging}/export`);
    if (await fingerprint(source) !== before) {
      throw new Error("source changed during export");
    }
  } else {throw new Error(
      "usage: rust-db-migrate.ts <fingerprint|prepare> <source> [staging]",
    );}
}
