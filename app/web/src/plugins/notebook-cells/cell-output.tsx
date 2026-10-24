// Cell outputs: the nbformat shapes a kernel produces, reduced from execution events and
// rendered as blocks. Rich HTML runs in a sandboxed iframe themed like the page.
import { useEffect, useRef, useState } from "react";
import type { CellOutput } from "../../api";
import { type Resolved, useResolvedTheme } from "../../ui/theme";

// one execution event, as /api/plugins/notebook-cells/execute streams them
export type CellEvent =
  | { type: "start"; kernel: string }
  | { type: "input"; count: number | null }
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | {
    type: "display_data" | "execute_result";
    data: Record<string, string | string[]>;
    metadata?: Record<string, unknown>;
    count?: number | null;
  }
  | { type: "error"; ename: string; evalue: string; traceback: string[] }
  | { type: "clear_output"; wait?: boolean }
  | { type: "reply"; status: string; count: number | null }
  | { type: "failed"; error: string };

export const MAX_OUTPUT_BYTES = 512 * 1024; // like an html block; a cell's outputs sync with the page

export type RunState = { outputs: CellOutput[]; clearPending: boolean; count: number | null };

const joined = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("") : v ?? "");

// the kernel's data bundle with every mime joined to one string
function mimeBundle(data: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k] = typeof v === "string" ? v : joined(v);
  return out;
}

// a terminal's carriage return: the segment after the last \r replaces the line so far
function withCarriageReturns(prev: string, next: string): string {
  let text = prev + next;
  if (!text.includes("\r")) return text;
  const lines = text.split("\n").map((line) => {
    const i = line.lastIndexOf("\r");
    return i < 0 ? line : line.slice(i + 1);
  });
  text = lines.join("\n");
  return text;
}

export function applyEvent(state: RunState, ev: CellEvent): RunState {
  let { outputs, clearPending, count } = state;
  const push = (o: CellOutput) => {
    if (clearPending) {
      outputs = [];
      clearPending = false;
    }
    outputs = [...outputs, o];
  };
  switch (ev.type) {
    case "stream": {
      const last = outputs.at(-1);
      if (!clearPending && last?.output_type === "stream" && last.name === ev.name) {
        outputs = [...outputs.slice(0, -1), { ...last, text: withCarriageReturns(last.text, ev.text) }];
      } else push({ output_type: "stream", name: ev.name, text: withCarriageReturns("", ev.text) });
      break;
    }
    case "display_data":
    case "execute_result":
      push({
        output_type: ev.type,
        data: mimeBundle(ev.data),
        ...(ev.metadata && Object.keys(ev.metadata).length ? { metadata: ev.metadata } : {}),
        ...(ev.type === "execute_result" ? { execution_count: ev.count ?? null } : {}),
      });
      break;
    case "error":
      push({ output_type: "error", ename: ev.ename, evalue: ev.evalue, traceback: ev.traceback });
      break;
    case "failed":
      push({ output_type: "error", ename: "Trame", evalue: ev.error, traceback: [] });
      break;
    case "clear_output":
      if (ev.wait) clearPending = true;
      else outputs = [];
      break;
    case "input":
    case "reply":
      if (ev.count != null) count = ev.count;
      break;
    default:
      break;
  }
  return { outputs, clearPending, count };
}

// what gets stored on the block: heavy mimes over the cap are replaced by a note
export function storable(outputs: CellOutput[]): CellOutput[] {
  const size = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;
  if (size(outputs) <= MAX_OUTPUT_BYTES) return outputs;
  return outputs.map((o) => {
    if (o.output_type !== "display_data" && o.output_type !== "execute_result") return o;
    const kb = Math.round(size(o) / 1024);
    if (kb * 1024 < MAX_OUTPUT_BYTES / 4) return o;
    return {
      ...o,
      data: { "text/plain": `[output of ${kb} KB not kept on the page — run the cell again to see it]` },
    };
  });
}

// ANSI SGR → styled runs (colors, bold, italic, underline); other escapes are dropped
export type Run = { text: string; style: string };
const ANSI_COLORS = [
  "#3b3b3b", "#d7504b", "#49a95a", "#c9a227", "#4a7fd6", "#b25fbf", "#2ea6a6", "#c8ccd4",
  "#7a7f8a", "#f0796f", "#6ccf7a", "#e3c567", "#78a4ef", "#d58ddb", "#5fd0d0", "#ffffff",
];
export function ansiRuns(text: string): Run[] {
  const runs: Run[] = [];
  // oxlint-disable-next-line no-control-regex -- ANSI escapes in kernel output
  const re = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]/g;
  let fg = "", bg = "", bold = false, italic = false, underline = false;
  const style = () =>
    [
      fg && `color:${fg}`,
      bg && `background:${bg}`,
      bold && "font-weight:600",
      italic && "font-style:italic",
      underline && "text-decoration:underline",
    ].filter(Boolean).join(";");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), style: style() });
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [fg, bg, bold, italic, underline] = ["", "", false, false, false];
      else if (c === 1) bold = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c === 39) fg = "";
      else if (c === 49) bg = "";
      else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90 + 8];
      else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
      else if (c >= 100 && c <= 107) bg = ANSI_COLORS[c - 100 + 8];
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const n = codes[i + 2] ?? 0;
        const color = n < 16 ? ANSI_COLORS[n] : n >= 232 ? `rgb(${(n - 232) * 10 + 8},${(n - 232) * 10 + 8},${(n - 232) * 10 + 8})` : (() => {
          const v = n - 16;
          const r = Math.floor(v / 36), g = Math.floor((v % 36) / 6), b = v % 6;
          const ch = (x: number) => (x === 0 ? 0 : x * 40 + 55);
          return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
        })();
        if (c === 38) fg = color;
        else bg = color;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) fg = color;
        else bg = color;
        i += 4;
      }
    }
  }
  if (last < text.length) runs.push({ text: text.slice(last), style: style() });
  return runs;
}

const cssOf = (style: string): React.CSSProperties => {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const [k, v] = part.split(":");
    if (!k || !v) continue;
    out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
};

function AnsiPre({ text, tone }: { text: string; tone?: "error" | "stderr" }) {
  const cls = tone === "error"
    ? "border-blocked/30 bg-blocked/[0.06]"
    : tone === "stderr"
    ? "border-paused/30 bg-paused/[0.06]"
    : "border-line-soft bg-well";
  return (
    <pre className={`m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-soft ${cls}`}>
      {ansiRuns(text).map((r, i) => (r.style ? <span key={i} style={cssOf(r.style)}>{r.text}</span> : r.text))}
    </pre>
  );
}

// the page's palette, so a pandas table or an svg reads like the rest of the page
export function outputTheme(theme: Resolved): string {
  const t = theme === "dark"
    ? { bg: "#0e1014", ink: "#e6e9ef", muted: "#8b93a3", line: "#232633", well: "#14161b" }
    : { bg: "#eef0f3", ink: "#1c1f26", muted: "#626a7c", line: "#e2e5ea", well: "#ffffff" };
  return `:root{color-scheme:${theme};--trame-bg:${t.bg};--trame-ink:${t.ink};--trame-muted:${t.muted};--trame-line:${t.line};--trame-accent:#c98a63}` +
    `html,body{margin:0;background:transparent;color:${t.ink};font:13px/1.5 ui-sans-serif,system-ui,sans-serif}` +
    `body{padding:2px 0}` +
    `table{border-collapse:collapse;font-size:12px}th,td{border:1px solid ${t.line};padding:2px 8px;text-align:right}` +
    `thead th{background:${t.well};color:${t.muted};font-weight:600}tbody tr:hover{background:${t.well}}` +
    `.dataframe{margin:0}img,svg{max-width:100%;height:auto}pre{white-space:pre-wrap}a{color:#c98a63}`;
}

const HEIGHT_BRIDGE =
  `<script>(function(){var post=function(){parent.postMessage({trame:"cell-height",height:document.documentElement.scrollHeight},"*")};` +
  `addEventListener("load",post);new ResizeObserver(post).observe(document.documentElement)})()</script>`;

function SandboxedHtml({ html, theme }: { html: string; theme: Resolved }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(40);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { trame?: unknown; height?: unknown };
      if (m?.trame === "cell-height" && typeof m.height === "number") setHeight(Math.min(Math.max(Math.ceil(m.height) + 4, 24), 2000));
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, []);
  const srcDoc = `<!doctype html><meta charset="utf-8"><style>${outputTheme(theme)}</style>${html}${HEIGHT_BRIDGE}`;
  return (
    <iframe
      ref={frame}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title="cell output"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}

// the richest mime we can show, in nbformat's preference order
export function pickMime(data: Record<string, string>): [string, string] | null {
  for (const mime of ["text/html", "image/svg+xml", "image/png", "image/jpeg", "text/markdown", "text/plain"]) {
    if (typeof data[mime] === "string") return [mime, data[mime]];
  }
  if (data["application/vnd.plotly.v1+json"] !== undefined) return ["application/vnd.plotly.v1+json", ""];
  const first = Object.keys(data)[0];
  return first ? [first, data[first]] : null;
}

function RichOutput({ data, theme }: { data: Record<string, string>; theme: Resolved }) {
  const picked = pickMime(data);
  if (!picked) return null;
  const [mime, value] = picked;
  if (mime === "text/html") return <SandboxedHtml html={value} theme={theme} />;
  if (mime === "image/svg+xml") return <SandboxedHtml html={value} theme={theme} />;
  if (mime === "image/png" || mime === "image/jpeg") {
    return <img src={`data:${mime};base64,${value.replace(/\s/g, "")}`} alt="" className="block max-w-full rounded-md" />;
  }
  if (mime === "text/plain" || mime === "text/markdown") return <AnsiPre text={value} />;
  return <AnsiPre text={`[${mime} output — not renderable here]`} />;
}

export function CellOutputs({ outputs }: { outputs: CellOutput[] }) {
  const theme = useResolvedTheme();
  if (outputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-soft px-2 py-2">
      {outputs.map((o, i) => {
        if (o.output_type === "stream") return <AnsiPre key={i} text={o.text} tone={o.name === "stderr" ? "stderr" : undefined} />;
        if (o.output_type === "error") {
          return <AnsiPre key={i} text={o.traceback.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`} tone="error" />;
        }
        return <RichOutput key={i} data={o.data} theme={theme} />;
      })}
    </div>
  );
}
