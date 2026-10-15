import type { Ctx } from "../core/ctx.ts";
import { defaultTagsFor, NODE_ID } from "./config.ts";
import { db } from "./db.ts";
import { localAuthorSettings } from "./identity.ts";

// This laptop: its PGlite (opened lazily on first query) and its node id.
export const APP_CTX: Ctx = {
  q: { query: async (text, params) => await (await db()).query(text, params) },
  origin: NODE_ID,
  defaultTags: defaultTagsFor,
  localAuthor: localAuthorSettings,
};

// APP_CTX bound to one transaction: every write in fn commits or rolls back together.
export async function inTransaction<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return await (await db()).transaction((tx) => fn({ ...APP_CTX, q: tx }));
}
