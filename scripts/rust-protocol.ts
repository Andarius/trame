// DESCRIPTION: Generate the Rust wire registry from the shared hub/frontend protocol.
// USAGE: bun scripts/rust-protocol.ts [--check]
import { readFile, writeFile } from "node:fs/promises";
import { ENTITIES, PROTOCOL_VERSION } from "../protocol/entities.ts";
const path = new URL("../protocol/rust-entities.json", import.meta.url);
const content = JSON.stringify({ version: PROTOCOL_VERSION, entities: ENTITIES }, null, 2) + "\n";
if (process.argv.slice(2).includes("--check")) {
  if (await readFile(path, "utf8") !== content) throw new Error("Rust protocol registry is stale; run scripts/rust-protocol.ts");
} else await writeFile(path, content);
