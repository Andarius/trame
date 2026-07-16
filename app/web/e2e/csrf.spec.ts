import { expect, test } from "@playwright/test";

// /api spawns terminals, opens files and approves deployments, so a page on a foreign
// origin must not reach it — while the app itself and header-less CLI writers (track.ts,
// the MCP server) must keep working.
test("a foreign origin is rejected on /api; the app and CLI clients are not", async ({ request }) => {
  const evil = { origin: "https://evil.example" };

  // blocked: reads too — a side-effecting GET is reachable from a bare <img src>
  expect((await request.get("/api/board", { headers: evil })).status()).toBe(403);
  expect((await request.post("/api/resume", { headers: evil, data: { probe: true } })).status()).toBe(403);
  // blocked: origin-less cross-site request (<img src=…/api/…>)
  expect((await request.get("/api/board", { headers: { "sec-fetch-site": "cross-site" } })).status()).toBe(403);
  // blocked: DNS rebinding keeps the attacker's own origin
  expect((await request.get("/api/board", { headers: { origin: "http://attacker.example:8790" } })).status()).toBe(403);

  // allowed: the vite dev proxy forwards :5173 as the origin
  expect((await request.get("/api/board", { headers: { origin: "http://localhost:5173" } })).status()).toBe(200);
  // allowed: same-origin app fetch
  expect((await request.get("/api/board", { headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(200);
  // allowed: track.ts / MCP send neither header
  expect((await request.get("/api/board")).status()).toBe(200);
});
