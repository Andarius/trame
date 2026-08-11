// Pasted-image storage. The `assets` table holds metadata only (mime, store, path);
// bytes live under ASSETS_DIR, or in an S3-compatible bucket when TRACKER_S3_* is set.
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import {
  ASSETS_DIR,
  S3_ACCESS_KEY,
  S3_BUCKET,
  S3_ENDPOINT,
  S3_PREFIX,
  S3_REGION,
  S3_SECRET_KEY,
} from "./config.ts";
import { db } from "./db.ts";

const s3 = S3_ENDPOINT && S3_BUCKET
  ? (() => {
    const u = new URL(S3_ENDPOINT);
    return new S3Client({
      endPoint: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      useSSL: u.protocol === "https:",
      region: S3_REGION || "us-east-1",
      accessKey: S3_ACCESS_KEY,
      secretKey: S3_SECRET_KEY,
      bucket: S3_BUCKET,
    });
  })()
  : null;

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

export async function putAsset(bytes: Uint8Array, mime: string): Promise<string> {
  const pg = await db();
  const store = s3 ? "s3" : "local";
  const row = (await pg.query(
    `insert into assets (mime, store, path) values ($1,$2,'') returning id`,
    [mime, store],
  )).rows[0] as { id: string };
  const name = `${row.id}${EXT[mime] ?? ""}`;
  if (s3) {
    await s3.putObject(`${S3_PREFIX}${name}`, bytes);
  } else {
    await Deno.mkdir(ASSETS_DIR, { recursive: true });
    await Deno.writeFile(`${ASSETS_DIR}/${name}`, bytes);
  }
  await pg.query(`update assets set path=$1 where id=$2`, [
    s3 ? `${S3_PREFIX}${name}` : name,
    row.id,
  ]);
  return row.id;
}

export async function getAsset(
  id: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | null> {
  const pg = await db();
  const row = (await pg.query(
    `select mime, store, path from assets where id=$1 and not deleted`,
    [id],
  )).rows[0] as { mime: string; store: string; path: string } | undefined;
  // guard the local read even though we wrote the path ourselves
  if (!row || !row.path || row.path.includes("..")) return null;
  if (row.store === "s3") {
    if (!s3) return null; // uploaded on a machine with S3 configured; this one isn't
    const resp = await s3.getObject(row.path).catch(() => null);
    if (!resp) return null;
    return { bytes: new Uint8Array(await resp.arrayBuffer()), mime: row.mime };
  }
  const bytes = await Deno.readFile(`${ASSETS_DIR}/${row.path}`).catch(() => null);
  return bytes ? { bytes, mime: row.mime } : null;
}
