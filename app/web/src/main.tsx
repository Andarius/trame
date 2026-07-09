import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyScale, getScale } from "./scale";

applyScale(getScale());

// A rebuild invalidates the hashed chunks a running client references; reload once to pick it up.
globalThis.addEventListener("vite:preloadError", (e) => {
  const key = "chunk-reload-at";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  if (Date.now() - last < 30_000) return; // avoid a reload loop if the chunk is truly gone
  sessionStorage.setItem(key, String(Date.now()));
  e.preventDefault();
  globalThis.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
