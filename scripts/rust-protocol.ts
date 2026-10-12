// DESCRIPTION: Generate the Rust wire registry from the shared hub/frontend protocol.
// USAGE: deno run --allow-read --allow-write scripts/rust-protocol.ts [--check]
import { ENTITIES, PROTOCOL_VERSION } from "../protocol/entities.ts";
const path = new URL("../protocol/rust-entities.json", import.meta.url);
const content = JSON.stringify({ version: PROTOCOL_VERSION, entities: ENTITIES }, null, 2) + "\n";
if (Deno.args.includes("--check")) {
  if (await Deno.readTextFile(path) !== content) throw new Error("Rust protocol registry is stale; run scripts/rust-protocol.ts");
} else await Deno.writeTextFile(path, content);
