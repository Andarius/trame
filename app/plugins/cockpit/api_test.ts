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

Deno.test("ticket creation sends nullable US and initial status without losing the source label", async () => {
  const { createTicket } = await import("./api.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assertEquals(await new Response(String(init?.body)).json(), {
      origin_id: "session:one",
      title: "Standalone",
      objective: "Keep history",
      description: null,
      user_story: null,
      status: "in_progress",
      source_status: "blocked",
    });
    return Response.json({
      reference: "GEN-1",
      updated_at: "now",
      created: false,
    });
  };
  try {
    assertEquals(
      (await createTicket("https://cockpit.test", "token", {
        kind: "product",
        slug: "devops",
      }, {
        originId: "session:one",
        title: "Standalone",
        objective: "Keep history",
        description: null,
        userStory: null,
        status: "in_progress",
        sourceStatus: "blocked",
      })).created,
      false,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("scope reads reject incomplete pagination instead of accepting a partial migration", async () => {
  const { fetchTickets } = await import("./api.ts");
  const original = globalThis.fetch;
  try {
    for (const cursor of [null, "repeated", "advancing"] as const) {
      let calls = 0;
      globalThis.fetch = () =>
        Promise.resolve(Response.json({
          now: "now",
          tickets: [],
          has_more: true,
          next_since: cursor === "advancing" ? String(++calls) : cursor,
        }));
      let failed = false;
      try {
        await fetchTickets("https://cockpit.test", "token", {
          kind: "product",
          slug: "devops",
        });
      } catch {
        failed = true;
      }
      assertEquals(failed, true);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("import preflight rejects older servers before any write", async () => {
  const { requireImportSupport } = await import("./api.ts");
  const original = globalThis.fetch;
  try {
    for (const supported of [false, true]) {
      globalThis.fetch = (url, init) => {
        assertEquals(String(url), "https://cockpit.test/api/sync/scopes");
        assertEquals(init?.method, undefined);
        return Promise.resolve(Response.json({
          scopes: [],
          ...(supported
            ? {
              capabilities: {
                initial_ticket_status: true,
                user_story_ids: true,
              },
            }
            : {}),
        }));
      };
      let failed = false;
      try {
        await requireImportSupport("https://cockpit.test", "token");
      } catch {
        failed = true;
      }
      assertEquals(failed, !supported);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("tag sync sends empty sets too, with the selected scope and source identity", async () => {
  const { syncTags } = await import("./api.ts");
  await withFetch((url, init) => {
    assertEquals(url, "https://cockpit.test/api/sync/tags?product=devops");
    assertEquals(init?.method, "POST");
    assertEquals(JSON.parse(String(init?.body)), {
      reference: "GEN-42",
      source_id: "trame:session:abc",
      tags: [],
    });
    return reply(200, { reference: "GEN-42", changed: true });
  }, async () => {
    assertEquals(
      await syncTags("https://cockpit.test", "tok", {
        kind: "product",
        slug: "devops",
      }, {
        reference: "GEN-42",
        sourceId: "trame:session:abc",
        tags: [],
      }),
      { reference: "GEN-42", changed: true },
    );
  });
});
