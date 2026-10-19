// DESCRIPTION: Migrate a synthetic PGlite fixture twice and check source preservation and idempotency.
// USAGE: bun scripts/rust-ci-fixture.ts
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fingerprint } from "./rust-db-migrate.ts";
import { scratchPath } from "./rust-db-export.ts";

const workspace = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const fixture = process.env.TRAME_CI_FIXTURE_DIR ??
  `${workspace}/.scratch/ci-fixture`;
await mkdir(fixture, {
  recursive: true,
  mode: 0o700,
});
const root = await scratchPath(fixture);
const source = `${root}/pglite`;
const target = `${root}/native`;
for (const path of [source, target]) {
  try {
    await lstat(path);
    throw new Error(
      `fixture already exists: ${path}; remove it explicitly before rerunning`,
    );
  } catch (error) {
    if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
}
const db = new PGlite(source);
try {
  await db.exec(await readFile(`${workspace}/db/schema.sql`, "utf8"));
  await db.exec(`
    insert into devices(id,node_id,user_id,origin,updated_at)
      select 'd843d5c5-2263-5cae-916e-a2fade824e4a','rust-spike',id,'rust-spike','2026-01-01T00:00:00Z'
      from users where not deleted;
    insert into pages(id,title,content,tags,updated_at) values
      ('99999999-0000-4000-8000-000000000001','Synthetic 🦀 page',
       '[{"id":"fixture-block","type":"text","text":"Unicode café 🦀 and preserved block"}]',
       '["fixture"]'::jsonb,'2026-01-01T00:00:00Z');
    insert into pages(id,title,deleted,updated_at) values
      ('99999999-0000-4000-8000-000000000002','Preserved tombstone',true,'2026-01-01T00:00:00Z');
    insert into sessions(id,title,repo_path,branch,summary,updated_at,last_touched) values
      ('99999999-0000-4000-8000-000000000003','Synthetic session',
       '/synthetic/repo','fixture','Preserved migration data','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
  `);
} finally {
  await db.close();
}
const before = await fingerprint(source);
for (let pass = 0; pass < 2; pass++) {
  const result = Bun.spawnSync(
    [`${workspace}/target/debug/trame-local`, "migrate", source],
    {
      env: {
        ...process.env,
        TRAME_LOCAL_DIR: target,
        TRAME_ISOLATED: "1",
        TRAME_OFFLINE: "1",
        TRAME_PG_BIN: process.env.TRAME_PG_BIN ??
          `${workspace}/.scratch/package/pg/usr/lib/postgresql/18/bin`,
        TRACKER_DATA_DIR: source,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!result.success) {
    await writeFile(`${root}/migration.log`, result.stderr, {
      mode: 0o600,
    });
    throw new Error(
      `synthetic migration pass ${pass + 1} failed; see ${root}/migration.log`,
    );
  }
}
if (await fingerprint(source) !== before) {
  throw new Error("migration changed the synthetic source");
}
console.log(
  "PASS: synthetic migration, source preservation and idempotency",
);
