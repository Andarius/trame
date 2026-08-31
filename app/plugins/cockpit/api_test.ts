import { assertEquals } from "@std/assert";
import { probe } from "./api.ts";

// The connection probe is the plugin's whole diagnostic surface: it runs before
// anything is saved and has to tell "wrong token" apart from "token fine, but
// nobody granted it a scope" — the state a first-time setup actually lands in.

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init))) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("probe treats 400 as success — authenticated and scoped", async () => {
  await withFetch(
    () => reply(400, { error: "Périmètre requis" }),
    async () => {
      const out = await probe("https://cockpit.test", "tok");
      assertEquals(out.ok, true);
    },
  );
});

Deno.test("probe reports a rejected token as auth", async () => {
  await withFetch(
    () => reply(401, { error: "Token invalide ou révoqué." }),
    async () => {
      const out = await probe("https://cockpit.test", "tok");
      assertEquals(out, {
        ok: false,
        kind: "auth",
        detail: "Token invalide ou révoqué.",
      });
    },
  );
});

Deno.test("probe distinguishes a scopeless token from a bad one", async () => {
  await withFetch(
    () => reply(403, { error: "Ce token n'a aucun périmètre de synchro." }),
    async () => {
      const out = await probe("https://cockpit.test", "tok");
      assertEquals(out.ok, false);
      assertEquals(out.ok === false && out.kind, "scope");
    },
  );
});

Deno.test("probe reports an unreachable host as network", async () => {
  await withFetch(
    () => {
      throw new TypeError("connection refused");
    },
    async () => {
      const out = await probe("https://cockpit.test", "tok");
      assertEquals(out.ok === false && out.kind, "network");
    },
  );
});

Deno.test("probe never calls out without a base URL or token", async () => {
  let called = false;
  await withFetch(
    () => {
      called = true;
      return reply(200, {});
    },
    async () => {
      assertEquals((await probe("", "tok")).ok, false);
      assertEquals((await probe("https://cockpit.test", "")).ok, false);
    },
  );
  assertEquals(called, false);
});

Deno.test("probe trims a trailing slash off the base URL", async () => {
  let seen = "";
  await withFetch(
    (url) => {
      seen = url;
      return reply(400, {});
    },
    async () => {
      await probe("https://cockpit.test/", "tok");
    },
  );
  assertEquals(seen, "https://cockpit.test/api/sync/tickets");
});
