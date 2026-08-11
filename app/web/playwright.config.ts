import { defineConfig } from "@playwright/test";

// E2E against the real Deno backend (PGlite included) in a fully isolated sandbox:
// data dir, port file, and settings all point at E2E_DIR so tests never touch real state.
const E2E_DIR = process.env.TRAME_E2E_DIR ?? "/tmp/trame-e2e";
const PORT = Number(process.env.TRAME_E2E_PORT ?? 8790);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 }, // CI runners cold-boot PGlite on the first request
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single backend instance — keep tests serialized
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "deno run -A ../main.ts",
    port: PORT,
    reuseExistingServer: false,
    timeout: 120_000, // first PGlite init downloads/extracts WASM
    env: {
      TRACKER_PORT: String(PORT),
      TRACKER_DATA_DIR: `${E2E_DIR}/pglite`,
      TRACKER_PORT_FILE: `${E2E_DIR}/port.json`,
      TRACKER_SETTINGS_FILE: `${E2E_DIR}/settings.json`,
      TRACKER_OUTBOX: `${E2E_DIR}/outbox.jsonl`,
      TRACKER_NODE_ID: "e2e",
      TRACKER_UPDATE_CHECK: "0",
      TRACKER_ASSETS_DIR: `${E2E_DIR}/assets`,
      TRACKER_CLAUDE_DIR: `${E2E_DIR}/claude-projects`,
      TRACKER_CODEX_DIR: `${E2E_DIR}/codex-sessions`,
      // deployments plugin never hits the network in e2e (path relative to the server cwd)
      TRACKER_DEPLOYMENTS_FIXTURE: "../plugins/deployments/fixture.sample.json",
    },
  },
});
