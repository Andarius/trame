import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Frontend development follows the isolated native backend's private readiness file,
// or the installed app's with TRAME_WEB_LIVE=1 (`just web-live`: real data).
async function apiTarget(): Promise<string> {
  const scratch = realpathSync(resolve("../../.scratch"));
  const live = process.env.TRAME_WEB_LIVE === "1";
  const portFile = live
    ? resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local/share"), "trame/port.json")
    : process.env.TRACKER_PORT_FILE ?? resolve(process.env.TRAME_LOCAL_DIR ?? "../../.scratch/dev", "port.json");
  const hint = live ? "start the Trame app first" : "start just serve first";
  if (!existsSync(portFile)) throw new Error(`Backend is unavailable; ${hint}`);
  const file = realpathSync(portFile);
  if (!live && !file.startsWith(`${scratch}/`)) throw new Error("Vite requires a scratch backend port file");
  const { port } = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8787 || port === 5181) {
    throw new Error("Invalid isolated backend port");
  }
  const base = `http://127.0.0.1:${port}`;
  const alive = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(800) })
    .then(async (r) => { await r.body?.cancel(); return r.ok; }).catch(() => false);
  if (!alive) throw new Error(`Backend is unavailable; ${hint}`);
  return base;
}

// terminals attach over a WebSocket, which the plain /api entry doesn't forward
async function devProxy() {
  const target = await apiTarget();
  return { "/api/term": { target, ws: true }, "/api": target };
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
  // shown by debug builds so a reload visibly picked up the new bundle
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  resolve: {
    alias: { "@trame/web-api": resolve("src/plugin-api.ts") },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // served over loopback; the big chunks are lazy (excalidraw font subsetting is 1.8 MB)
    chunkSizeWarningLimit: 2000,
    // excalidraw's editor lazily imports the mermaid converter (mermaid+katex+cytoscape,
    // ~5MB); we only use exportToSvg — keep it out of the embedded bundle
    rollupOptions: { external: [/@excalidraw\/mermaid-to-excalidraw/] },
  },
  // the editor imports core/, shared with the hub
  server: { fs: { allow: ["..", "../../core", ...localPlugins()] }, proxy: command === "serve" ? await devProxy() : undefined },
}));
