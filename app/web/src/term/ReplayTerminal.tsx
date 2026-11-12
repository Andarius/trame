import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import { termTheme } from "./term-api";
import { openLink } from "./TerminalView";
import { FONT_STACK, scrollbar, theme, URL_RE } from "./xterm-look";

// A read-only terminal showing `text` (ANSI), with the same look as the shells
export function ReplayTerminal({ text, className }: { text: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: FONT_STACK,
      fontSize: 13,
      drawBoldTextInBrightColors: false,
      disableStdin: true,
      cursorInactiveStyle: "none",
      scrollback: 5_000,
      theme: { ...theme(), ...scrollbar() },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri), { urlRegex: URL_RE }));
    term.open(el);
    let alive = true;
    const draw = () => {
      if (!alive) return;
      fit.fit();
      term.reset();
      term.write("\x1b[?25l" + text, () => term.scrollToBottom()); // no cursor: nothing to type into
    };
    void Promise.all([termTheme(), document.fonts.load('13px "JetBrains Mono"').catch(() => [])]).then(([t]) => {
      if (!alive) return;
      if (t) {
        term.options.fontFamily = t.fontFamily ? `"${t.fontFamily}", ${FONT_STACK}` : FONT_STACK;
        term.options.fontSize = t.fontSize ?? 13;
      }
      const look = { ...(t?.theme ?? theme()), ...scrollbar() };
      term.options.theme = look;
      el.style.background = look.background ?? "";
      draw();
    });
    // rewrap on resize: the text is ours, so redraw it at the new width
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(draw, 50);
    });
    observer.observe(el);
    return () => {
      alive = false;
      clearTimeout(timer);
      observer.disconnect();
      term.dispose();
    };
  }, [text]);
  return <div ref={host} className={`rounded-lg px-3 py-2 ${className ?? ""}`} />;
}
