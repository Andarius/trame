// HTML block contract. Docs render in sandboxed iframes (allow-scripts, never
// allow-same-origin); the appended bridge reports content height and exposes
// window.trame.send(data) so a doc can persist structured results on its block.
// The web renderer mirrors this snippet (Vite can't import outside web/src).

export const HTML_BLOCK_MAX_BYTES = 512 * 1024;
export const HTML_DATA_MAX_BYTES = 64 * 1024;

export const HTML_BLOCK_BRIDGE =
  `<style>:root{--trame-bg:#0f1115;--trame-card:#181b22;--trame-ink:#e6e9ef;--trame-muted:#9aa3b2;--trame-accent:#c98a63;--trame-line:#2a2f3a}</style>` +
  `<script>(function(){` +
  `window.trame={send:function(d){parent.postMessage({trame:"data",data:d},"*")}};` +
  `addEventListener("message",function(e){if(e.data&&e.data.trame==="init"){window.trame.data=e.data.data;dispatchEvent(new Event("trame:init"))}});` +
  `var post=function(){parent.postMessage({trame:"height",height:document.documentElement.scrollHeight},"*")};` +
  `addEventListener("load",post);` +
  `new ResizeObserver(post).observe(document.documentElement)` +
  `})()</script>`;

export const withBridge = (html: string): string => html + HTML_BLOCK_BRIDGE;
