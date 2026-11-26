import { useCallback, useEffect, useRef, useState } from "react";
import { CLOSE_AUTH, CLOSE_GONE, termToken } from "../term/term-api";
import { enumCodec, useLocalStorage } from "../ui/ui";
import { applyEvent, type P, type Provider, type Reply, type RunState, type RunSummary } from "./agent-run-state";

export * from "./agent-run-state";

// Where a provider's sessions open: the terminal unless the user opted into the agent view.
export type AgentDest = "terminal" | "agent";
const DEST_CODEC = enumCodec<AgentDest>(["terminal", "agent"]);
export const useAgentDest = (p: Provider) => useLocalStorage<AgentDest>(`trame:agentDest:${p}`, "terminal", DEST_CODEC);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await termToken();
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-trame-term": token } });
  const body = await r.json().catch(() => ({}));
  // the body rides along: a refused resume names the run that already holds the conversation
  if (!r.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `agent: ${r.status}`), { body });
  return body as T;
}
export const listRuns = () => call<RunSummary[]>("/api/agent/runs");
export const startRun = (body: { cwd: string; resume?: string; mode?: string; provider?: Provider }) =>
  call<RunSummary>("/api/agent/runs", { method: "POST", body: JSON.stringify(body) });
export const restartRun = (id: string) => call<{ ok: boolean }>(`/api/agent/runs/${id}/restart`, { method: "POST" });
// an idle run continues in a Trame shell, and an idle shell's Claude in the agent view
export const runToTerminal = (id: string) => call<{ term: string }>(`/api/agent/runs/${id}/handoff`, { method: "POST" });
export const terminalToRun = (term: string) =>
  call<RunSummary>("/api/agent/handoff", { method: "POST", body: JSON.stringify({ term }) });
// the run already holding a conversation, from a refused start
export const heldBy = (e: unknown) => ((e as { body?: { run?: string } }).body?.run) ?? null;
export const deleteRun = (id: string) => call<{ ok: boolean }>(`/api/agent/runs/${id}`, { method: "DELETE" });

type Frame =
  | { type: "attached"; lease: number }
  | { type: "snapshot"; epoch: string; seq: number; state: RunState }
  | { type: "event"; epoch: string; seq: number; kind: string; payload: P }
  | { type: "lease"; writer: number }
  | { type: "reply"; commandId: string; accepted: boolean; reason?: string };

export type RunView = {
  state: RunState | null;
  epoch: string | null;
  connected: boolean;
  writer: boolean;
  gone: boolean;
  send: (kind: string, payload?: P) => Promise<Reply>;
  takeOver: () => void;
};

// Follow one run over its WebSocket: resume from the last event seen, take the writer lease, batch renders.
export function useAgentRun(id: string): RunView {
  const [view, setView] = useState<Omit<RunView, "send" | "takeOver">>({
    state: null,
    epoch: null,
    connected: false,
    writer: false,
    gone: false,
  });
  const cur = useRef({ state: null as RunState | null, epoch: null as string | null, seq: 0, lease: 0, writer: false });
  const ws = useRef<WebSocket | null>(null);
  const replies = useRef(new Map<string, (r: Reply) => void>());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    cur.current = { state: null, epoch: null, seq: 0, lease: 0, writer: false };
    setView({ state: null, epoch: null, connected: false, writer: false, gone: false });
  }, [id]);

  useEffect(() => {
    let alive = true;
    let frame = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // streamed deltas arrive faster than frames: render at most once per frame
    const flush = () => {
      frame = 0;
      const c = cur.current;
      setView((v) => ({ ...v, state: c.state, epoch: c.epoch, writer: c.writer }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const connect = async (fresh: boolean) => {
      const token = await termToken(fresh).catch(() => null);
      if (!alive || !token) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/api/agent/runs/${id}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        const c = cur.current;
        sock.send(JSON.stringify({ type: "attach", token, role: "writer", epoch: c.epoch, afterSeq: c.epoch ? c.seq : undefined }));
        setView((v) => ({ ...v, connected: true }));
      };
      sock.onmessage = (m) => {
        const f = JSON.parse(String(m.data)) as Frame;
        const c = cur.current;
        if (f.type === "attached") {
          c.lease = f.lease;
          c.writer = f.lease > 0;
        } else if (f.type === "lease") c.writer = c.lease > 0 && f.writer === c.lease;
        else if (f.type === "snapshot") {
          c.state = f.state;
          c.epoch = f.epoch;
          c.seq = f.seq;
        } else if (f.type === "event") {
          // a new epoch always starts with a snapshot; an older event was already applied
          if (!c.state || f.epoch !== c.epoch || f.seq <= c.seq) return;
          c.state = applyEvent(c.state, f.kind, f.payload);
          c.seq = f.seq;
        } else if (f.type === "reply") {
          replies.current.get(f.commandId)?.({ accepted: f.accepted, reason: f.reason });
          replies.current.delete(f.commandId);
          return;
        }
        schedule();
      };
      sock.onclose = (e) => {
        if (ws.current === sock) ws.current = null;
        for (const done of replies.current.values()) done({ accepted: false, reason: "disconnected" });
        replies.current.clear();
        if (!alive) return;
        if (e.code === CLOSE_GONE) return setView((v) => ({ ...v, connected: false, gone: true }));
        setView((v) => ({ ...v, connected: false }));
        retry = setTimeout(() => void connect(e.code === CLOSE_AUTH), 1000);
      };
    };
    void connect(false);
    return () => {
      alive = false;
      clearTimeout(retry);
      if (frame) cancelAnimationFrame(frame);
      ws.current?.close();
      ws.current = null;
    };
  }, [id, generation]);

  const send = useCallback((kind: string, payload: P = {}) => {
    const sock = ws.current;
    const epoch = cur.current.epoch;
    if (!sock || sock.readyState !== WebSocket.OPEN || !epoch) {
      return Promise.resolve({ accepted: false, reason: "not connected" });
    }
    const commandId = crypto.randomUUID();
    return new Promise<Reply>((resolve) => {
      replies.current.set(commandId, resolve);
      sock.send(JSON.stringify({ type: "command", commandId, epoch, kind, payload }));
    });
  }, []);
  // attaching again as a writer takes the lease back from another window
  const takeOver = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...view, send, takeOver };
}

// The runs Trame owns, refreshed while something shows them.
export function useAgentRuns(enabled: boolean) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => listRuns().then((r) => alive && setRuns(r), () => {});
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return runs;
}
