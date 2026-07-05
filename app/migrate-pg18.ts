// DESCRIPTION: manual PG16 → PG18 data-dir migration (the app also does this
// automatically on startup — this exists for migrating without launching it).
// USAGE: deno task migrate:pg18   (from app/, with the Trame app CLOSED)
import { DATA_DIR, PORT_FILE } from "./config.ts";
import { dataDirPgVersion, migrateDataDir } from "./migrate.ts";

const version = await dataDirPgVersion();
if (version === null) {
  console.log(`no data dir at ${DATA_DIR} — nothing to migrate`);
  Deno.exit(0);
}
if (version === "18") {
  console.log(`${DATA_DIR} is already PG 18 — nothing to do`);
  Deno.exit(0);
}

// Refuse to touch the dir while an app instance is holding it. Older builds don't
// report their dataDir — treat that as "could be this dir" and abort.
try {
  const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
  const res = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    const status = await res.json().catch(() => ({}));
    if (!status.dataDir || status.dataDir === DATA_DIR) {
      console.error("the Trame app is running (and may hold this data dir) — close it first, then re-run");
      Deno.exit(1);
    }
  }
} catch { /* no port file or nothing listening — good */ }

try {
  await migrateDataDir();
} catch {
  Deno.exit(1);
}
