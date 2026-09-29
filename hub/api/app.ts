// Hono app factory — takes the DB adapter so tests run it on PGlite.
import { type Context, Hono, type Next } from "hono";
import { PROTOCOL_VERSION } from "../../protocol/entities.ts";
import { syncRequestSchema } from "../../protocol/schema.ts";
import type { SyncRequest } from "../../protocol/types.ts";
import type { DB } from "./db.ts";
import { type Caller, verifyToken } from "./auth.ts";
import { handleCoreApi } from "../../core/api.ts";
import type { Q as CoreQ } from "../../core/ctx.ts";

type Env = { Variables: { caller: Caller } };

class RolledBack extends Error {}

// versioned so an older client gets a clear signal, never a stuck queue
function protocolMismatch(version: string | undefined): string | null {
  return version === String(PROTOCOL_VERSION)
    ? null
    : `protocol mismatch: server speaks ${PROTOCOL_VERSION}, client sent ${
      version ?? "none"
    }`;
}

// `core` runs the shared /api routes; main.ts gives it a connection that stores
// JSON-text params as jsonb values (the core SQL passes JSON.stringify'd strings).
export function createApp(db: DB, core: DB = db): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, protocol: PROTOCOL_VERSION }));

  const auth = async (c: Context<Env>, next: Next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const caller = token ? await verifyToken(db, token) : null;
    if (!caller) return c.json({ error: "invalid or missing token" }, 401);
    c.set("caller", caller);
    await next();
  };
  app.use("/sync", auth);
  app.use("/api/*", auth);

  // The laptop app's /api contract, for clients with no local app (tramecli on a
  // headless box). Members only until the routes apply the guest ACL filter.
  app.all("/api/*", async (c) => {
    const mismatch = protocolMismatch(c.req.header("x-trame-protocol"));
    if (mismatch) return c.json({ error: mismatch }, 400);
    const caller = c.get("caller");
    // explicit live member row: loadAccess treats a missing/deleted user as a member
    const member = caller.userId
      ? await db.query(
        `select 1 from users where id=$1 and role='member' and not deleted`,
        [caller.userId],
      )
      : [];
    if (!member.length) {
      return c.json({ error: "the hub /api is for members only" }, 403);
    }
    let rejected: Response | undefined;
    const res = await core.transaction(async (tx) => {
      await tx.query(`select set_config('trame.source', 'api', true)`);
      await tx.query(`select set_config('trame.actor', $1, true)`, [
        caller.userId,
      ]);
      const q: CoreQ = {
        query: async <T>(text: string, params?: unknown[]) => ({
          rows: await tx.query(text, params) as T[],
        }),
      };
      const out = await handleCoreApi(
        { q, origin: caller.nodeId },
        c.req.raw,
        new URL(c.req.url),
      );
      // a route that answers an error must not commit what it wrote before failing
      if (out && out.status >= 400) {
        rejected = out;
        throw new RolledBack();
      }
      return out;
    }).catch((e) => {
      if (e instanceof RolledBack && rejected) return rejected;
      throw e;
    });
    return res ?? c.json({ error: "not found" }, 404);
  });

  // WSS bypasses the HTTP middleware chain, so the token is re-checked HERE, at
  // the handshake, and a bad one is rejected before the upgrade completes.
  // WebSocket clients can't set an Authorization header — the token rides a query
  // param, which TLS keeps off the wire.
  app.get("/ws", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "websocket endpoint" }, 426);
    }
    const caller = await verifyToken(db, c.req.query("token") ?? "");
    if (!caller) return c.json({ error: "invalid or missing token" }, 401);
    const { handleWs } = await import("./realtime.ts");
    return handleWs(db, c.req.raw, caller.nodeId);
  });

  app.post("/sync", async (c) => {
    const mismatch = protocolMismatch(c.req.header("x-trame-protocol"));
    if (mismatch) return c.json({ error: mismatch }, 400);
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
