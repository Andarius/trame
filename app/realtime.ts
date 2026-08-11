// WS nudge listener (docs-site/src/content/docs/hub-api.md §Realtime, client side). Nudges only trigger
// a normal /sync — correctness never depends on the socket, and the 15s poll keeps
// running underneath as the fallback. npm:ws because the web WebSocket can't trust
// a private CA; ws passes {ca} straight to tls.connect.
// @ts-types="npm:@types/ws@^8"
import WSClient from "ws";
import { db } from "./db.ts";
import { TLS_DIR } from "./config.ts";
import { getHubApi } from "./files.ts";

const PING_MS = 25_000; // server idleTimeout is 60s — keep traffic well under it
const MAX_BACKOFF_MS = 60_000;

function caCert(): string | undefined {
  try {
    return Deno.readTextFileSync(`${TLS_DIR}/ca.crt`);
  } catch {
    return undefined;
  }
}

async function cursor(): Promise<number | null> {
  try {
    const pg = await db();
    const r = (await pg.query(`select api_cursor from sync_state where id=1`))
      .rows[0] as { api_cursor: number | string | null };
    return r.api_cursor === null ? null : Number(r.api_cursor);
  } catch {
    return null;
  }
}

// Fire-and-forget: keeps one socket alive to the hub whenever API sync is enabled
// (re-checked each cycle, so flipping syncViaApi applies without a restart), with
// exponential backoff + jitter on every failure path.
export function startRealtime(onNudge: () => void): void {
  let attempt = 0;

  const connect = async () => {
    const cfg = await getHubApi().catch(() => null);
    if (!cfg) {
      setTimeout(connect, 30_000); // not enabled (yet) — check again later
      return;
    }
    const url = `${cfg.url.replace(/^http/, "ws")}/ws?token=${
      encodeURIComponent(cfg.token)
    }`;
    let ping: ReturnType<typeof setInterval> | undefined;
    const retry = () => {
      clearInterval(ping);
      const backoff = Math.min(1000 * 2 ** attempt++, MAX_BACKOFF_MS);
      setTimeout(connect, backoff * (0.75 + Math.random() * 0.5));
    };
    try {
      const ws = new WSClient(url, { ca: caCert() });
      let closed = false;
      ws.on("open", async () => {
        attempt = 0;
        // catch-up: if the log moved past our cursor while we were down, the
        // server answers with one nudge and the next /sync reconciles
        ws.send(JSON.stringify({ type: "hello", cursor: await cursor() }));
        ping = setInterval(
          () => ws.send(JSON.stringify({ type: "ping" })),
          PING_MS,
        );
      });
      ws.on("message", (data: unknown) => {
        try {
          if (JSON.parse(String(data)).type === "changed") onNudge();
        } catch { /* not ours */ }
      });
      ws.on("close", () => {
        if (!closed) {
          closed = true;
          retry();
        }
      });
      ws.on("error", () => {
        ws.close();
        if (!closed) {
          closed = true;
          retry();
        }
      });
    } catch {
      retry();
    }
  };

  connect();
}
