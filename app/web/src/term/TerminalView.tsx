import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
// Ghostty's built-in default font, bundled so the panel matches without a system install
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400-italic.css";
import { openInBrowser } from "../api";
import { CLOSE_AUTH, CLOSE_GONE, CLOSE_SUPERSEDED, closeTerminal, termImage, type TermTheme, termTheme, termToken } from "./term-api";
import { imageLinks } from "./image-links";
import { previewBox } from "./preview-size";
import { FONT_STACK, scrollbar, theme, URL_RE } from "./xterm-look";

type Notice = "superseded" | "gone" | null;
// an image path under the mouse (a thumbnail by it) or clicked (full size)
type Preview = { path: string; x: number; y: number; full: boolean };

function ImagePreview({ p, onClose }: { p: Preview; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    termImage(p.path).then(
      (u) => (live ? setSrc((url = u)) : URL.revokeObjectURL(u)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [p.path]);
  useEffect(() => {
    if (!p.full) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [p.full, onClose]);
  const box = previewBox();
  const body = error
    ? <span className="px-3 py-2 text-[11.5px] text-ink-muted">{error}</span>
    : src
    ? (
      <img
        src={src}
        alt={p.path}
        className={p.full ? "max-h-[88vh] max-w-[92vw] object-contain" : "object-contain"}
        style={p.full ? undefined : { maxWidth: box.w, maxHeight: box.h }}
      />
    )
    : <span className="px-3 py-2 text-[11.5px] text-ink-muted">loading…</span>;
  if (p.full) {
    return createPortal(
      <div role="dialog" aria-label={p.path} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/75" onClick={onClose}>
        {body}
        <span className="font-mono text-[11px] text-white/70">{p.path}</span>
      </div>,
      document.body,
    );
  }
  // beside the pointer, flipped to stay on screen
  const left = p.x + box.w + 20 > innerWidth ? p.x - box.w - 16 : p.x + 16;
  const top = p.y + box.h + 20 > innerHeight ? p.y - box.h - 16 : p.y + 16;
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 overflow-hidden rounded-md border border-chipline bg-panel-modal shadow-lg shadow-black/40"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
    >
      {body}
    </div>,
    document.body,
  );
}

// the selection as a quote to answer under, like a chat's Reply: "> " lines, terminal padding trimmed
export const quoteReply = (text: string) =>
  `${text.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "").split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WebKitGTK can refuse the async clipboard: fall back to a hidden textarea
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// Trame's own links (what `tramecli` prints, from this app or another port on this machine)
// open in place through the app's history handling; anything else goes to the browser
export function openLink(uri: string) {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  const trame = u.origin === location.origin || (loopback && /[?&](card|session|page|db)=/.test(u.search));
  if (!trame) {
    void openInBrowser(uri);
    return;
  }
  const q = new URLSearchParams(u.search);
  const legacy = q.get("session");
  if (legacy && !q.get("card")) {
    q.delete("session");
    q.set("card", legacy);
  }
  history.pushState(null, "", `/?${q}`);
  dispatchEvent(new PopStateEvent("popstate"));
}

// One backend shell. Stays mounted while hidden so its screen and scrollback survive tab switches.
export function TerminalView(
  { id, visible, focused, onFocus }: { id: string; visible: boolean; focused: boolean; onFocus: () => void },
) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<
    { start: () => void; fit: () => void; focus: () => void; reconnect: () => void; term: Terminal } | null
  >(null);
  const [notice, setNotice] = useState<Notice>(null);
  // a selection's Copy / Reply bubble, where the mouse let go (px in the pane)
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const focusCb = useRef(onFocus);
  focusCb.current = onFocus;

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: FONT_STACK,
      fontSize: 13,
      drawBoldTextInBrightColors: false, // Ghostty's default
      cursorBlink: true,
      scrollback: 10_000,
      theme: { ...theme(), ...scrollbar() },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri), { urlRegex: URL_RE }));
    // image paths: hover shows a thumbnail, click the full image
    const links = term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const found = imageLinks(line).map((m) => ({
          range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
          text: m.path,
          decorations: { underline: true, pointerCursor: true },
          activate: (e: MouseEvent) => setPreview({ path: m.path, x: e.clientX, y: e.clientY, full: true }),
          hover: (e: MouseEvent) => setPreview((p) => p?.full ? p : { path: m.path, x: e.clientX, y: e.clientY, full: false }),
          leave: () => setPreview((p) => (p?.full ? p : null)),
        }));
        cb(found.length ? found : undefined);
      },
    });
    term.open(el);
    term.textarea?.addEventListener("focus", () => focusCb.current());
    // DOM renderer on purpose: WebGL ignores the app's thin (antialiased) font smoothing

    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    let offset: number | null = null; // bytes of output seen, for a gap-free re-attach
    let done = false; // exited, superseded or unmounted: no automatic reconnect
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const send = (data: string | Uint8Array<ArrayBuffer>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };
    const connect = async (freshToken = false) => {
      clearTimeout(timer);
      let token: string;
      try {
        token = await termToken(freshToken);
      } catch {
        return schedule();
      }
      if (done) return;
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/term/${id}/ws`);
      ws = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () =>
        sock.send(JSON.stringify({ type: "auth", token, from: offset, cols: term.cols, rows: term.rows }));
      sock.onmessage = (e) => {
        if (typeof e.data !== "string") {
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          offset = (offset ?? 0) + bytes.length;
          term.write(bytes);
          return;
        }
        const msg = JSON.parse(e.data);
        if (msg.type === "attach") {
          retry = 0;
          if (msg.reset) term.reset();
          offset = msg.offset;
        } else if (msg.type === "exit") {
          // `exit` closes the pane, like Ghostty
          done = true;
          void closeTerminal(id);
        }
      };
      sock.onclose = (e) => {
        if (ws !== sock || done) return;
        if (e.code === CLOSE_SUPERSEDED) {
          done = true;
          setNotice("superseded");
        } else if (e.code === CLOSE_GONE) {
          done = true;
          setNotice("gone");
        } else schedule(e.code === CLOSE_AUTH);
      };
    };
    const schedule = (freshToken = false) => {
      if (done) return;
      timer = setTimeout(() => void connect(freshToken), Math.min(200 * 2 ** retry++, 5000));
    };

    term.onSelectionChange(() => {
      if (!term.hasSelection()) setBubble(null);
    });
    term.onScroll(() => setBubble(null));
    term.onData((d) => send(enc.encode(d)));
    term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    // the shell only hears the size once a drag settles: every SIGWINCH makes zsh and TUIs redraw
    let ptyTimer: ReturnType<typeof setTimeout> | undefined;
    term.onResize(() => {
      clearTimeout(ptyTimer);
      ptyTimer = setTimeout(() => send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })), 200);
    });

    const refit = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
    };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, 30);
    });
    observer.observe(el);
    let ghostty: TermTheme | null = null;
    // Ghostty's look when found; otherwise follow the app's light/dark switch
    const restyle = () => {
      const t = { ...(ghostty?.theme ?? theme()), ...scrollbar() };
      term.options.theme = t;
      el.style.background = t.background ?? "";
    };
    const adopt = (t: TermTheme | null) => {
      ghostty = t;
      if (t) {
        term.options.fontFamily = t.fontFamily ? `"${t.fontFamily}", ${FONT_STACK}` : FONT_STACK;
        term.options.fontSize = t.fontSize ?? 13;
      }
      restyle();
    };
    const themeObserver = new MutationObserver(restyle);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", restyle);

    // attach on first show: a collapsed dock in another window must not take the shell over
    let started = false;
    api.current = {
      start: () => {
        if (started) return;
        started = true;
        void Promise.all([termTheme(), document.fonts.load('13px "JetBrains Mono"').catch(() => [])]).then(([t]) => {
          adopt(t);
          refit();
          void connect();
        });
      },
      fit: refit,
      focus: () => term.focus(),
      term,
      reconnect: () => {
        setNotice(null);
        done = false;
        retry = 0;
        void connect();
      },
    };

    return () => {
      done = true;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      clearTimeout(ptyTimer);
      observer.disconnect();
      themeObserver.disconnect();
      media.removeEventListener("change", restyle);
      ws?.close();
      links.dispose();
      term.dispose();
      api.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!visible) return;
    api.current?.start();
    const raf = requestAnimationFrame(() => {
      api.current?.fit();
      if (focused) api.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, focused]);

  const act = (reply: boolean) => {
    const term = api.current?.term;
    if (!term?.hasSelection()) return;
    const text = term.getSelection();
    // without bracketed paste every newline runs a line, and `> text` truncates a file in a shell
    if (reply && term.modes.bracketedPasteMode) term.paste(quoteReply(text));
    else void copyText(text);
    term.clearSelection();
    term.focus();
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={host}
        className="h-full w-full px-2 pt-1 pb-3"
        onMouseUp={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - r.left, y: e.clientY - r.top };
          // xterm settles the selection after mouseup
          requestAnimationFrame(() => setBubble(api.current?.term.hasSelection() ? at : null));
        }}
      />
      {bubble && (
        <div
          className="absolute z-20 flex -translate-x-1/2 items-center overflow-hidden rounded-md border border-chipline bg-panel-modal text-[11.5px] text-ink-soft shadow-lg shadow-black/40"
          style={{ left: Math.max(60, bubble.x), top: Math.max(4, bubble.y - 34) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" className="px-2.5 py-1 hover:bg-active-row hover:text-ink" onClick={() => act(false)}>
            Copy
          </button>
          <span className="h-4 w-px bg-line" />
          <button
            type="button"
            className="px-2.5 py-1 hover:bg-active-row hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!api.current?.term.modes.bracketedPasteMode}
            title={api.current?.term.modes.bracketedPasteMode
              ? "paste the selection as a > quote at the prompt, to answer under it"
              : "this program doesn't take pasted text safely"}
            onClick={() => act(true)}
          >
            Reply
          </button>
        </div>
      )}
      {preview && <ImagePreview p={preview} onClose={() => setPreview(null)} />}
      {notice && (
        <div className="absolute inset-0 flex items-center justify-center bg-block/80 text-xs text-ink-soft">
          {notice === "superseded"
            ? (
              <button type="button" className="rounded-md border border-line px-3 py-1.5 hover:text-ink" onClick={() => api.current?.reconnect()}>
                Opened in another window — take it back
              </button>
            )
            : "This terminal no longer exists."}
        </div>
      )}
    </div>
  );
}
