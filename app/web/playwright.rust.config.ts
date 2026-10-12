import { resolve } from "node:path";

process.env.TRAME_E2E_DIR ??= resolve("../../.scratch/stage1/e2e-fixtures");
const { default: config } = await import("./playwright.config");
const server = config.webServer as Exclude<typeof config.webServer, unknown[]>;

export default {
  ...config,
  webServer: {
    ...server,
    command: "../../target/debug/trame-local",
    env: {
      ...server?.env,
      TRAME_LOCAL_DIR: process.env.TRAME_LOCAL_DIR ?? resolve("../../.scratch/stage1/e2e-db"),
      TRACKER_DEPLOYMENTS_FIXTURE: resolve("../plugins/deployments/fixture.sample.json"),
    },
  },
};
