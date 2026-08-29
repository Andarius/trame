import { defineConfig } from "@playwright/test";
import { execSync } from "node:child_process";

// E2E against the real Deno backend (PGlite included) in a fully isolated sandbox:
// data dir, port file, and settings all point at E2E_DIR so tests never touch real state.
const E2E_DIR = process.env.TRAME_E2E_DIR ?? "/tmp/trame-e2e";

// first free port at or above `start` — an unrelated service on the default port
// must not kill the run (config code must be sync, hence the child probe)
const freePort = (start: number): number =>
  Number(
    execSync(
      `node -e '
        const net = require("net");
        const free = (p) => new Promise((r) => {
          const s = net.createServer();
          s.once("error", () => r(false));
          s.listen(p, "127.0.0.1", () => s.close(() => r(true)));
        });
        (async () => {
          for (let p = ${start}; p < ${start} + 20; p++) {
            if (await free(p)) { console.log(p); return; }
          }
          process.exit(1);
        })();
      '`,
    ).toString().trim(),
  );

const PORT = process.env.TRAME_E2E_PORT
  ? Number(process.env.TRAME_E2E_PORT)
  : freePort(8790);
// global-setup (same process) reads the env, not this module — keep them agreeing
process.env.TRAME_E2E_PORT = String(PORT);

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
