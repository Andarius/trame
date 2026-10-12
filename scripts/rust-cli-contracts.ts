// DESCRIPTION: Generate the Rust CLI help and MCP descriptions from TypeScript contracts.
// USAGE: deno run -A scripts/rust-cli-contracts.ts [--check]
import { HTML_BLOCK_MAX_BYTES } from "../protocol/html.ts";

Deno.env.delete("TRAME_BUILD");
const help = await import("../track/help.ts");
const root = new URL("../crates/trame-cli/src/", import.meta.url);
const mcp = await Deno.readTextFile(new URL("../mcp/server.ts", import.meta.url));

function literalAt(source: string, start: number): string {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") throw new Error(`expected string at ${start}`);
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === quote) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated string at ${start}`);
}

const helpPath = new URL("help.json", root);
const keys = Object.keys(JSON.parse(await Deno.readTextFile(helpPath)));
const topics = Object.fromEntries(keys.map((key) => {
  const value = (help as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`missing help topic ${key}`);
  return [key, value];
}));

const marker = "const CAPABILITIES = ";
const capStart = mcp.indexOf(marker) + marker.length;
if (capStart < marker.length) throw new Error("CAPABILITIES not found");
const capabilityExpr = literalAt(mcp, capStart);
const capabilities = new Function(
  "PAGE_DIALECT", "GRAPH_FENCE", "TODO_SYNTAX", "SPECS_WHEN", "UDB_CONTRACT",
  `return ${capabilityExpr}`,
)(help.PAGE_DIALECT, help.GRAPH_FENCE, help.TODO_SYNTAX, help.SPECS_WHEN, help.UDB_CONTRACT) as string;

const matches = [...mcp.matchAll(/server\.tool\(\s*"(trame_[^"]+)",\s*/g)];
const descriptions: Record<string, string> = {};
const fieldDescriptions: Record<string, Record<string, string>> = {};
for (const [index, match] of matches.entries()) {
  const start = match.index! + match[0].length;
  const expression = literalAt(mcp, start);
  descriptions[match[1]] = new Function("SPECS_WHEN", `return ${expression}`)(help.SPECS_WHEN) as string;
  const end = index + 1 < matches.length ? matches[index + 1].index! : mcp.length;
  const body = mcp.slice(start + expression.length, end);
  for (const line of body.matchAll(/\n {4}([a-z_]+):\s*z\./g)) {
    const fieldStart = line.index! + line[0].length;
    const next = body.slice(fieldStart).search(/\n {4}[a-z_]+:\s*z\./);
    const section = body.slice(fieldStart, next < 0 ? undefined : fieldStart + next);
    const described = section.match(/\.describe\(\s*/);
    if (!described) continue;
    const at = fieldStart + described.index! + described[0].length;
    const value = new Function(`return ${literalAt(body, at)}`)() as string;
    (fieldDescriptions[match[1]] ??= {})[line[1]] = value;
  }
}
if (Object.keys(descriptions).length !== 15 || Object.values(fieldDescriptions).reduce((n, v) => n + Object.keys(v).length, 0) !== 4) {
  throw new Error("MCP tool or field descriptions changed; review the generator");
}

const outputs = new Map([
  [helpPath, JSON.stringify(topics) + "\n"],
  [new URL("capabilities.txt", root), capabilities],
  [new URL("mcp-contracts.json", root), JSON.stringify({ descriptions, fieldDescriptions, htmlBlockMaxBytes: HTML_BLOCK_MAX_BYTES }, null, 2) + "\n"],
]);
for (const [path, content] of outputs) {
  if (Deno.args.includes("--check")) {
    if (await Deno.readTextFile(path) !== content) throw new Error(`${path.pathname} is stale; run scripts/rust-cli-contracts.ts`);
  } else await Deno.writeTextFile(path, content);
}
