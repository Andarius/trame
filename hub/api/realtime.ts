// WS nudge fan-out (docs-site/src/content/docs/hub-api.md §Realtime). The socket carries invalidation
// nudges ONLY — "there are changes ≥ rev N, pull" — never data, so correctness
// always rests on /sync and a dropped socket loses nothing.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Q } from "./db.ts";

// A slow/stuck client must never stall fan-out or grow memory: past this buffered
// backlog we close it and let its reconnect/poll fallback take over.
const MAX_BUFFERED = 64 * 1024;

type WsData = { db: Q; nodeId: string };
export type WsServer = Server<WsData>;
type Socket = ServerWebSocket<WsData>;
const sockets = new Set<Socket>();

export function connectedClients(): number {
  return sockets.size;
}

async function headRev(db: Q): Promise<number> {
  const r = await db.query(
    `select coalesce(max(rev), 0)::bigint as rev from change_log`,
  );
  return Number(r[0].rev);
}

function nudge(socket: Socket, rev: number): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.getBufferedAmount() > MAX_BUFFERED) {
    socket.close(1013, "backpressure — fall back to polling");
    return;
  }
  socket.send(JSON.stringify({ type: "changed", rev }));
}

// Broadcast the current head revision to every live socket (debounced by main.ts).
export async function broadcast(db: Q): Promise<void> {
  if (!sockets.size) return;
  const rev = await headRev(db);
  for (const s of sockets) nudge(s, rev);
}

// Upgrade a request whose token was already verified; `server` is the Bun server Hono passes as env.
export function handleWs(db: Q, req: Request, nodeId: string, server: WsServer): Response {
  return server.upgrade(req, { data: { db, nodeId } })
    ? new Response(null)
    : Response.json({ error: "websocket upgrade failed" }, { status: 400 });
}

// Socket lifecycle: register, hello catch-up (client reconnects with its cursor — if the log
// moved past it while the socket was down, one nudge brings it up to date), app-level
// ping/pong, deregister. idleTimeout closes half-open connections.
export const websocket: WebSocketHandler<WsData> = {
  idleTimeout: 60,
  open(socket) {
    sockets.add(socket);
    console.log(`ws: ${socket.data.nodeId} connected (${sockets.size} online)`);
  },
  close(socket) {
    sockets.delete(socket);
    console.log(`ws: ${socket.data.nodeId} disconnected (${sockets.size} online)`);
  },
  async message(socket, data) {
    let msg: { type?: string; cursor?: number };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "ping" && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "pong" }));
    }
    if (msg.type === "hello") {
      const rev = await headRev(socket.data.db);
      if (msg.cursor === null || msg.cursor === undefined || rev > msg.cursor) {
        nudge(socket, rev);
      }
    }
  },
};
