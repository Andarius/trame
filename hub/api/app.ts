// Hono app factory — takes the DB adapter so tests run it on PGlite.
import { Hono } from "hono";
import { PROTOCOL_VERSION } from "../../protocol/entities.ts";
import { syncRequestSchema } from "../../protocol/schema.ts";
import type { SyncRequest } from "../../protocol/types.ts";
import type { DB } from "./db.ts";
import { type Caller, verifyToken } from "./auth.ts";

type Env = { Variables: { caller: Caller } };

export function createApp(db: DB): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, protocol: PROTOCOL_VERSION }));

  app.use("/sync", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const caller = token ? await verifyToken(db, token) : null;
    if (!caller) return c.json({ error: "invalid or missing token" }, 401);
    c.set("caller", caller);
    await next();
  });

  app.post("/sync", async (c) => {
    // versioned so an older client gets a clear signal, never a stuck queue
    const version = c.req.header("x-trame-protocol");
    if (version !== String(PROTOCOL_VERSION)) {
      return c.json(
        {
          error:
            `protocol mismatch: server speaks ${PROTOCOL_VERSION}, client sent ${
              version ?? "none"
            }`,
        },
        400,
      );
    }
    const parsed = syncRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({
        error: `invalid sync request: ${parsed.error.issues[0]?.message}`,
      }, 400);
    }
    const { handleSync } = await import("./sync.ts");
    return c.json(
      await handleSync(db, parsed.data as SyncRequest, c.get("caller")),
    );
  });

  app.onError((e, c) => {
    console.error(e);
    return c.json({ error: String(e?.message ?? e) }, 500);
  });

  return app;
}
