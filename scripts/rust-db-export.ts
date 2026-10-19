// DESCRIPTION: Export an isolated PGlite copy without applying the app schema.
// USAGE: bun scripts/rust-db-export.ts <copied .scratch dir> <existing output dir>
import { readFile, realpath, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

export async function scratchPath(path: string): Promise<string> {
  const resolved = await realpath(path);
  const source = process.env.TRAME_MIGRATION_SOURCE;
  const staging = process.env.TRAME_MIGRATION_STAGING;
  if (source && resolved === await realpath(source)) return resolved;
  if (staging) {
    const root = await realpath(staging);
    if (resolved === root || resolved.startsWith(`${root}/`)) return resolved;
  }
  const root = await realpath(new URL("../.scratch", import.meta.url));
  if (!resolved.startsWith(`${root}/`)) {
    throw new Error("path must resolve inside this repo's .scratch");
  }
  return resolved;
}

export async function exportPglite(copy: string, output: string): Promise<void> {
  if (!copy || !output) {
    throw new Error(
      "usage: rust-db-export.ts <copied .scratch PGlite dir> <output dir>",
    );
  }
  const safeCopy = await scratchPath(copy);
  const safeOutput = await scratchPath(output);
  if ((await readFile(`${safeCopy}/PG_VERSION`, "utf8")).trim() !== "18") {
    throw new Error("copied database must be PostgreSQL18");
  }
  const pg = new PGlite(safeCopy);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const literal = (value: string | null) =>
    value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
  try {
    await pg.waitReady;
    await pg.exec(
      "begin isolation level repeatable read; set timezone='UTC'; set datestyle='ISO, YMD'; set extra_float_digits=3;",
    );
    const names = (await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
    )).rows;
    const tables = [];
    const inserts = [
      "begin; set session_replication_role=replica;",
      `truncate ${
        names.map(({ table_name }) => quote(table_name)).join(",")
      } restart identity cascade;`,
    ];
    for (const { table_name: name } of names) {
      const columns = (await pg.query<
        {
          name: string;
          type: string;
          nullable: boolean;
          default: string | null;
          identity: string;
          generated: string;
        }
      >(
        `select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,
       not a.attnotnull as nullable, pg_get_expr(d.adbin,d.adrelid) as default,
       a.attidentity as identity, a.attgenerated as generated
       from pg_attribute a join pg_class c on c.oid=a.attrelid
       left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
       where c.relnamespace='public'::regnamespace and c.relname=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`,
        [name],
      )).rows;
      const rows = (await pg.query<{ values: (string | null)[] }>(
        `select json_build_array(${
          columns.map((c) => `${quote(c.name)}::text`).join(",")
        }) as values from ${quote(name)}`,
      )).rows.map((r) => r.values).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b), "en")
      );
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(rows)),
          ),
        ),
      ).map((b) => b.toString(16).padStart(2, "0")).join("");
      const deleted = columns.findIndex((c) => c.name === "deleted");
      tables.push({
        name,
        columns,
        rows,
        sha256: hash,
        tombstones: deleted < 0
          ? null
          : rows.filter((r) => r[deleted] === "true").length,
      });
      for (const row of rows) {
        inserts.push(
          `insert into ${quote(name)} (${
            columns.map((c) => quote(c.name)).join(",")
          }) overriding system value values (${row.map(literal).join(",")});`,
        );
      }
      for (const column of columns) {
        if (!column.nullable) {
          inserts.push(
            `alter table ${quote(name)} alter column ${quote(column.name)} set not null;`,
          );
        }
      }
    }
    const sequences = [];
    for (
      const { sequencename } of (await pg.query<{ sequencename: string }>(
        "select sequencename from pg_sequences where schemaname='public' order by sequencename",
      )).rows
    ) {
      const state = (await pg.query<{ value: string; called: boolean }>(
        `select last_value::text as value,is_called as called from ${
          quote(sequencename)
        }`,
      )).rows[0];
      sequences.push({ name: sequencename, ...state });
      inserts.push(
        `select setval(${literal(sequencename)},${
          literal(state.value)
        }::bigint,${state.called});`,
      );
    }
    inserts.push("set session_replication_role=origin; commit;");
    await writeFile(`${safeOutput}/db-export.json`, JSON.stringify({
        version: 1,
        pgVersion: "18",
        pglite: "0.5.3",
        tables,
        sequences,
      }), { mode: 0o600 });
    await writeFile(`${safeOutput}/db-data.sql`, inserts.join("\n"), {
      mode: 0o600,
    });
    await writeFile(`${safeOutput}/pages.json`, JSON.stringify((await pg.query("select * from pages order by id")).rows), { mode: 0o600 });
    await pg.exec("commit");
    console.log(
      JSON.stringify({
        tables: tables.map(({ name, rows, sha256, tombstones }) => ({
          name,
          rows: rows.length,
          sha256,
          tombstones,
        })),
        sequences,
      }),
    );
  } finally {
    await pg.close();
  }
}

if (import.meta.main) await exportPglite(process.argv.slice(2)[0], process.argv.slice(2)[1]);
