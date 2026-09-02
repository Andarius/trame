import { assertEquals } from "@std/assert";
import {
  mappingTag,
  parseMappings,
  scopeKey,
  scopeOf,
  scopeQuery,
} from "./scope.ts";

// The mapping list decides what leaves this machine's network and what lands in
// it. Every case below must fail CLOSED: unreadable input removes a mapping, it
// never invents or widens one.

Deno.test("scopeOf reads a product mapping", () => {
  assertEquals(scopeOf({ product: "mobile", pageId: "" }), {
    kind: "product",
    slug: "mobile",
  });
});

Deno.test("scopeOf reads a flow mapping", () => {
  assertEquals(scopeOf({ flow: "billing", pageId: "" }), {
    kind: "flow",
    slug: "billing",
  });
});

Deno.test("scopeOf refuses product and flow together", () => {
  // Ambiguous — the server rejects it too, so we refuse before the round trip.
  assertEquals(
    scopeOf({ product: "mobile", flow: "billing", pageId: "" }),
    null,
  );
});

Deno.test("scopeOf refuses malformed slugs", () => {
  for (
    const slug of ["", "   ", "Mobile", "mo bile", "*", "a,b", "a/b", "a:b"]
  ) {
    assertEquals(scopeOf({ product: slug, pageId: "" }), null, `slug: ${slug}`);
  }
});

Deno.test("scopeOf trims surrounding space", () => {
  assertEquals(scopeOf({ product: "  mobile  ", pageId: "" }), {
    kind: "product",
    slug: "mobile",
  });
});

Deno.test("parseMappings drops malformed rows and keeps good ones", () => {
  const rows = parseMappings([
    { product: "mobile", pageId: "p1" },
    { product: "Mobile", pageId: "p2" }, // bad slug
    { product: "x", flow: "y", pageId: "p3" }, // ambiguous
    "nonsense",
    null,
    { pageId: "p4" }, // no scope at all
    { flow: "billing", pageId: "p5" },
  ]);
  assertEquals(rows.map((m) => scopeKey(scopeOf(m)!)), [
    "product:mobile",
    "flow:billing",
  ]);
});

Deno.test("parseMappings refuses a duplicate scope", () => {
  // Two mappings on one scope would poll it twice and fight over one watermark.
  const rows = parseMappings([
    { product: "mobile", pageId: "p1" },
    { product: "mobile", pageId: "p2" },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].pageId, "p1");
});

Deno.test("parseMappings returns nothing for non-arrays", () => {
  for (const raw of [null, undefined, "", 0, {}, "product:mobile"]) {
    assertEquals(parseMappings(raw), []);
  }
});

Deno.test("scopeQuery escapes the slug", () => {
  assertEquals(
    scopeQuery({ kind: "product", slug: "mobile" }),
    "product=mobile",
  );
  assertEquals(
    scopeQuery({ kind: "flow", slug: "multi_entity" }),
    "flow=multi_entity",
  );
});

// The tag a mapping stamps is configurable: a team's own vocabulary rarely
// matches the other tool's slugs.

Deno.test("mappingTag falls back to the scope's own slug", () => {
  assertEquals(mappingTag({ product: "devops", pageId: "p" }), "devops");
  assertEquals(mappingTag({ flow: "billing", pageId: "p" }), "billing");
});

Deno.test("mappingTag prefers the configured tag", () => {
  assertEquals(mappingTag({ product: "devops", tag: "infra", pageId: "p" }), "infra");
});

Deno.test("mappingTag ignores a blank tag rather than stamping nothing", () => {
  // An empty string would tag every mirrored page with "", which renders as a
  // chip with no name and matches nothing.
  assertEquals(mappingTag({ product: "devops", tag: "   ", pageId: "p" }), "devops");
});

Deno.test("parseMappings drops a tag that is not a slug", () => {
  // Kept as a mapping, minus the unusable tag: refusing the whole row would
  // silently unmap a project because of a cosmetic field.
  const [m] = parseMappings([{ product: "devops", tag: "Not A Slug!", pageId: "p" }]);
  assertEquals(m.tag, undefined);
  assertEquals(mappingTag(m), "devops");
});

Deno.test("parseMappings lowercases a tag", () => {
  const [m] = parseMappings([{ product: "devops", tag: "Infra", pageId: "p" }]);
  assertEquals(m.tag, "infra");
});
