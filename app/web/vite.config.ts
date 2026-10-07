import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Resolve the running Trame instance (desktop mode binds a random port and
// publishes it to the port file). The file survives crashes/quits, so probe the
// instance before trusting it. Falls back to the fixed `just serve` port.
async function apiTarget(): Promise<string> {
  try {
    const dataHome = process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`;
    const { port } = JSON.parse(readFileSync(`${dataHome}/trame/port.json`, "utf8"));
    const alive = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(800),
    }).then((r) => r.ok).catch(() => false);
    if (alive) return `http://127.0.0.1:${port}`;
    console.warn(`port.json points at :${port} but nothing answers — proxying to :8787 (just serve / just hack)`);
  } catch { /* no port file */ }
  return "http://localhost:8787";
}

// out-of-tree plugin checkouts (scripts/gen-plugins.ts): the dev server may serve their files
function localPlugins(): string[] {
  try {
    const { plugins = [] } = JSON.parse(readFileSync("../../plugins.local.json", "utf8"));
    return plugins.map((p: string) => resolve("../..", p));
  } catch { return []; }
}

// `npm run dev` serves on :5173 with React HMR and proxies /api to the running app.
// `npm run build` emits ./dist, which the Deno server serves in the desktop window.
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@trame/web-api": resolve("src/plugin-api.ts") },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // excalidraw's editor lazily imports the mermaid converter (mermaid+katex+cytoscape,
    // ~5MB); we only use exportToSvg — keep it out of the embedded bundle
    rollupOptions: { external: [/@excalidraw\/mermaid-to-excalidraw/] },
  },
  // the editor shares app/todo-marks.ts with the Deno side
  server: { fs: { allow: ["..", "../../core", ...localPlugins()] }, proxy: { "/api": await apiTarget() } },
}));
