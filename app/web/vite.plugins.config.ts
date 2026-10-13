// Builds the locally composed plugins' frontend (plugins.local.json) as one classic script the
// native app loads at runtime (`just plugins-install`); React and @trame/web-api stay external
// and resolve to window.__trame, set by src/plugins/runtime.ts.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: process.env.TRAME_PLUGINS_WEB_OUT ?? "dist-plugins",
    emptyOutDir: true,
    lib: {
      entry: resolve("src/plugins/runtime-entry.ts"),
      formats: ["iife"],
      name: "__tramePluginsBundle",
      fileName: () => "plugins.js",
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "@trame/web-api"],
      output: {
        assetFileNames: "plugins.[ext]",
        globals: {
          react: "__trame.React",
          "react/jsx-runtime": "__trame.jsxRuntime",
          "@trame/web-api": "__trame.webApi",
        },
      },
    },
  },
});
