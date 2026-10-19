// DESCRIPTION: Compile app/plugin-host.ts and the composed plugins into one standalone binary.
// USAGE: bun scripts/build-plugin-host.ts <outfile>
import { resolve } from "node:path";

const outfile = process.argv[2];
if (!outfile) {
  console.error("usage: bun scripts/build-plugin-host.ts <outfile>");
  process.exit(2);
}
const app = new URL("../app/", import.meta.url).pathname;
// out-of-tree plugins (plugins.local.json) import Trame's plugin API by these names
const aliases: Record<string, string> = {
  "@trame/plugin-api": `${app}plugins/api.ts`,
  "@trame/plugin-test": `${app}test_tmp.ts`,
};
const result = await Bun.build({
  entrypoints: [`${app}plugin-host.ts`],
  compile: { outfile: resolve(outfile) },
  minify: true,
  plugins: [{
    name: "trame-plugin-api",
    setup(build) {
      build.onResolve({ filter: /^@trame\/plugin-(api|test)$/ }, (args) => ({ path: aliases[args.path] }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
