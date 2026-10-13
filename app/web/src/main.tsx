import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { registerRuntimePlugins } from "./plugins";
import { loadRuntimePlugins } from "./plugins/runtime";
import { applyScale, getScale } from "./ui/scale";
import { applyTheme, getTheme } from "./ui/theme";

applyScale(getScale());
applyTheme(getTheme());

// A rebuild invalidates the hashed chunks a running client references; reload once to pick it up.
globalThis.addEventListener("vite:preloadError", (e) => {
  const key = "chunk-reload-at";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  if (Date.now() - last < 30_000) return; // avoid a reload loop if the chunk is truly gone
  sessionStorage.setItem(key, String(Date.now()));
  e.preventDefault();
  globalThis.location.reload();
});

// the registry must be complete before the first render: plugin hooks need a stable order
loadRuntimePlugins().then(registerRuntimePlugins, console.error).finally(() =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
);
