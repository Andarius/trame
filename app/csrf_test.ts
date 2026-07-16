import { assertEquals } from "@std/assert";
import { isCrossSite } from "./csrf.ts";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:8787/api/resume", { headers });

Deno.test("isCrossSite blocks foreign pages but never non-browser clients", async (t) => {
  const cases: [string, Record<string, string>, boolean][] = [
    // non-browser clients (track.ts, the MCP server, curl) send neither header
    ["no headers → allowed", {}, false],
    // the app itself
    ["same-origin fetch", { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8787" }, false],
    ["desktop webview (no Sec-Fetch-Site)", { origin: "http://127.0.0.1:41234" }, false],
    ["vite dev proxy forwards :5173 origin", { origin: "http://localhost:5173" }, false],
    ["browser top-level navigation", { "sec-fetch-site": "none" }, false],
    // attackers
    ["attacker page fetch", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }, true],
    ["attacker origin without Sec-Fetch-Site", { origin: "https://evil.example" }, true],
    ["origin-less cross-site <img src>", { "sec-fetch-site": "cross-site" }, true],
    ["same-site but other origin", { "sec-fetch-site": "same-site" }, true],
    // DNS rebinding keeps the attacker's own origin
    ["rebound attacker host", { origin: "http://attacker.example:8787" }, true],
  ];
  for (const [name, headers, want] of cases) {
    await t.step(name, () => assertEquals(isCrossSite(req(headers)), want));
  }
});
