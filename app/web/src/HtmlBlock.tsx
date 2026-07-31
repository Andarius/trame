import { useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "./api";

type HtmlB = Extract<Block, { type: "html" }>;

// mirrors protocol/html.ts (the web bundle can't import outside web/src)
const MAX_HTML_BYTES = 512 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const BRIDGE =
  `<style>:root{--trame-bg:#0f1115;--trame-card:#181b22;--trame-ink:#e6e9ef;--trame-muted:#9aa3b2;--trame-accent:#c98a63;--trame-line:#2a2f3a}</style>` +
  `<script>(function(){` +
  `window.trame={send:function(d){parent.postMessage({trame:"data",data:d},"*")}};` +
  `addEventListener("message",function(e){if(e.data&&e.data.trame==="init"){window.trame.data=e.data.data;dispatchEvent(new Event("trame:init"))}});` +
  `var post=function(){parent.postMessage({trame:"height",height:document.documentElement.scrollHeight},"*")};` +
  `addEventListener("load",post);` +
  `new ResizeObserver(post).observe(document.documentElement)` +
  `})()</script>`;

const docTitle = (html: string) =>
  html.match(/<title[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? "HTML";

export function HtmlBlock(
  { block, onPatch, onRemove }: {
    block: HtmlB;
    onPatch: (patch: Partial<HtmlB>) => void;
    onRemove: () => void;
  },
) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;
  const [autoH, setAutoH] = useState(180);
  const [editing, setEditing] = useState(!block.html);
  const [draft, setDraft] = useState(block.html);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dataTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Bridge: the doc reports its height and can persist structured data on the block.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { trame?: unknown; height?: unknown; data?: unknown };
      if (!m || typeof m !== "object") return;
      if (m.trame === "height" && typeof m.height === "number") {
        setAutoH(Math.min(Math.max(Math.ceil(m.height) + 2, 48), 3000));
      } else if (m.trame === "data") {
        let s: string | undefined;
        try {
          s = JSON.stringify(m.data);
        } catch {
          return;
        }
        if (s === undefined || s.length > MAX_DATA_BYTES) return;
        const data = JSON.parse(s);
        // debounce: interactive docs send on every click
        clearTimeout(dataTimer.current);
        dataTimer.current = setTimeout(() => patchRef.current({ data }), 400);
      }
    };
    addEventListener("message", onMsg);
    return () => {
      removeEventListener("message", onMsg);
      clearTimeout(dataTimer.current);
    };
  }, []);

  const srcDoc = useMemo(() => block.html + BRIDGE, [block.html]);
  const pinned = typeof block.height === "number";
  const height = pinned ? block.height as number : autoH;
  // hand persisted data back to the doc on (re)load so it can restore its state
  const dataRef = useRef(block.data);
  dataRef.current = block.data;
  const sendInit = () =>
    frame.current?.contentWindow?.postMessage(
      { trame: "init", data: dataRef.current },
      "*",
    );

  const commit = (html: string) => {
    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
      setErr(
        `document is over ${
          MAX_HTML_BYTES / 1024
        } KB — trim it, or show it from a folder block instead`,
      );
      return;
    }
    setErr(null);
    setEditing(false);
    if (html !== block.html) onPatch({ html });
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const from = { y: e.clientY, h: height };
    let last: number | null = null;
    const move = (ev: MouseEvent) => {
      last = Math.min(Math.max(from.h + ev.clientY - from.y, 48), 3000);
      if (frame.current) frame.current.style.height = `${last}px`;
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      if (last !== null) onPatch({ height: last });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };

  return (
    <div className="group/html my-1 overflow-hidden rounded-lg border border-line bg-block">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="shrink-0 font-mono text-[11px] font-semibold text-copper">
          {"</>"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">
          {docTitle(block.html)}
        </span>
        {block.data !== undefined && (
          <button
            type="button"
            title={`persisted data (click to copy)\n${
              JSON.stringify(block.data, null, 1)
            }`}
            onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(block.data));
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="shrink-0 rounded-full border border-chip-active-border bg-chip-active-bg px-2 py-[1px] text-[10px] font-semibold text-active"
          >
            {copied ? "copied ✓" : "data"}
          </button>
        )}
        {pinned && (
          <button
            type="button"
            title="back to auto-height"
            onClick={() => onPatch({ height: undefined })}
            className="shrink-0 rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper"
          >
            auto
          </button>
        )}
        <label className="shrink-0 cursor-pointer rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper">
          import
          <input
            type="file"
            accept=".html,.htm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) f.text().then((t) => (setDraft(t), commit(t)));
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setDraft(block.html);
            setEditing((v) => !v);
            setErr(null);
          }}
          className="shrink-0 rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper"
        >
          {editing ? "view" : "edit"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="retirer le bloc"
          className="shrink-0 rounded px-1 text-ink-muted/60 hover:bg-panel hover:text-blocked"
        >
          ×
        </button>
      </div>

      {editing
        ? (
          <div className="flex flex-col gap-2 p-2">
            <textarea
              autoFocus
              value={draft}
              spellCheck={false}
              placeholder="Paste a self-contained HTML document (inline CSS/JS, no external assets)…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  commit(draft);
                }
                if (e.key === "Escape" && block.html) {
                  setEditing(false);
                  setErr(null);
                }
              }}
              className="h-[260px] w-full resize-y rounded-md border border-line-soft bg-well p-2 font-mono text-[11.5px] leading-relaxed text-ink-soft outline-none placeholder:text-ink-muted/40 focus:border-copper/50"
            />
            {err && <span className="text-[11.5px] text-blocked">⚠ {err}</span>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => commit(draft)}
                className="rounded-md bg-copper px-3 py-1 text-[11.5px] font-semibold text-copper-ink"
              >
                Save
              </button>
              <span className="text-[10.5px] text-ink-muted/60">
                ⌘⏎ to save · docs can call window.trame.send(data) to hand
                results back
              </span>
            </div>
          </div>
        )
        : (
          <>
            <iframe
              ref={frame}
              sandbox="allow-scripts"
              allow="clipboard-write"
              srcDoc={srcDoc}
              onLoad={sendInit}
              title={docTitle(block.html)}
              className="block w-full border-0 bg-block"
              style={{ height }}
            />
            <div
              onMouseDown={startDrag}
              title="drag to set height"
              className="h-[5px] cursor-ns-resize bg-transparent transition-colors hover:bg-copper/30"
            />
          </>
        )}
    </div>
  );
}
