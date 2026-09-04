// Entry for the public link viewer (see vite.link.config.ts): the hub injects the
// page payload as window.__TRAME_LINK__ and this renders it read-only with the
// app's own components — same Markdown, same theme, same tab/fold sections.
import React from "react";
import { createRoot } from "react-dom/client";
import { type LinkData, LinkPage } from "./LinkPage";

const data = (globalThis as { __TRAME_LINK__?: LinkData }).__TRAME_LINK__;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {data
      ? <LinkPage data={data} />
      : (
        <p className="p-8 text-center text-ink-muted">
          This link doesn't exist or was revoked.
        </p>
      )}
  </React.StrictMode>,
);
