import { rm } from "node:fs/promises";

// Fresh sandbox for every run — the webServer creates a clean PGlite dir inside it.
export default async function globalSetup() {
  await rm("/tmp/trame-e2e", { recursive: true, force: true });
}
