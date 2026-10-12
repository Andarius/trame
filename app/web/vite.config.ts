import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Frontend development follows the isolated native backend's private readiness file.
async function apiTarget(): Promise<string> {
  const scratch = realpathSync(resolve("../../.scratch"));
  const file = realpathSync(process.env.TRACKER_PORT_FILE ??
    resolve(process.env.TRAME_LOCAL_DIR ?? "../../.scratch/dev", "port.json"));
  if (!file.startsWith(`${scratch}/`)) throw new Error("Vite requires a scratch backend port file");
  const { port } = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8787 || port === 5181) {
    throw new Error("Invalid isolated backend port");
  }
  const base = `http://127.0.0.1:${port}`;
  const alive = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(800) })
    .then(async (r) => { await r.body?.cancel(); return r.ok; }).catch(() => false);
  if (!alive) throw new Error("Isolated backend is unavailable; start just serve first");
  return base;
}

// out-of-tree plugin checkouts (scripts/gen-plugins.ts): the dev server may serve their files
function localPlugins(): string[] {
  try {
    const { plugins = [] } = JSON.parse(readFileSync("../../plugins.local.json", "utf8"));
    return plugins.map((p: string) => resolve("../..", p));
  } catch { return []; }
}

// Builds read no runtime discovery files; Vite HMR uses only the scratch backend.
export default defineConfig(async ({ command }) => ({
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
  server: { fs: { allow: ["..", "../../core", ...localPlugins()] }, proxy: command === "serve" ? { "/api": await apiTarget() } : undefined },
}));
