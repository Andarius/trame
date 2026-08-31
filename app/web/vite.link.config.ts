import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Public link viewer — a second, standalone build (`npm run build:link`) of the
// read-only page renderer the hub serves on /l/<token>. Reuses the app's md.tsx
// and Tailwind theme so shared pages look exactly like the app. Assets land in
// dist-link and are embedded into hub/api/link-embed.ts by scripts/gen-link-embed.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/l/assets/",
  build: {
    outDir: "dist-link",
    emptyOutDir: true,
    rollupOptions: { input: "link.html" },
  },
});
