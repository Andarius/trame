// WS nudge fan-out (docs/hub-api.md §Realtime). The socket carries invalidation
// nudges ONLY — "there are changes ≥ rev N, pull" — never data, so correctness
// always rests on /sync and a dropped socket loses nothing.
import type { Q } from "./db.ts";

// A slow/stuck client must never stall fan-out or grow memory: past this buffered
// backlog we close it and let its reconnect/poll fallback take over.
const MAX_BUFFERED = 64 * 1024;

const sockets = new Set<WebSocket>();

export function connectedClients(): number {
  return sockets.size;
}

async function headRev(db: Q): Promise<number> {
  const r = await db.query(
    `select coalesce(max(rev), 0)::bigint as rev from change_log`,
  );
  return Number(r[0].rev);
}

function nudge(socket: WebSocket, rev: number): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED) {
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

// Upgrade a request whose token was already verified. Owns the socket lifecycle:
// register, hello catch-up (client reconnects with its cursor — if the log moved
// past it while the socket was down, one nudge brings it up to date), app-level
// ping/pong, deregister. idleTimeout closes half-open connections.
export function handleWs(db: Q, req: Request, nodeId = "?"): Response {
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 60 });
  socket.onopen = () => {
    sockets.add(socket);
    console.log(`ws: ${nodeId} connected (${sockets.size} online)`);
  };
  socket.onclose = () => {
    sockets.delete(socket);
    console.log(`ws: ${nodeId} disconnected (${sockets.size} online)`);
  };
  socket.onerror = () => sockets.delete(socket);
  socket.onmessage = async (ev) => {
    let msg: { type?: string; cursor?: number };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "ping") nudgePong(socket);
    if (msg.type === "hello") {
      const rev = await headRev(db);
      if (msg.cursor === null || msg.cursor === undefined || rev > msg.cursor) {
        nudge(socket, rev);
      }
    }
  };
  return response;
}

function nudgePong(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "pong" }));
  }
}
