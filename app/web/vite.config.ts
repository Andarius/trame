import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Resolve the running Trame instance (desktop mode binds a random port and
// publishes it to the port file). Falls back to the fixed `just serve` port.
function apiTarget(): string {
  try {
    const dataHome = process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`;
    const { port } = JSON.parse(readFileSync(`${dataHome}/session-tracker/port.json`, "utf8"));
    return `http://127.0.0.1:${port}`;
  } catch {
    return "http://localhost:8787";
  }
}

// `npm run dev` serves on :5173 with React HMR and proxies /api to the running app.
// `npm run build` emits ./dist, which the Deno server serves in the desktop window.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": apiTarget() } },
});
