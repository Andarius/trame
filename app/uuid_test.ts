import { describe, expect, test } from "bun:test";
import { uuidV5 } from "../core/uuid.ts";

describe("uuidV5 derives RFC 9562 name-based ids", () => {
  for (
    const [id, namespace, name, expected] of [
      ["rfc dns example", "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com", "2ed6657d-e927-568b-95e1-2665a8aea6a2"],
      ["tag namespace", "3c9e0b71-2f45-4d18-a6c3-8e5417b9d0aa", "infra", "3321c1db-040c-5c77-aaf6-dae9bfd5d2a8"],
      ["empty name", "9c1f4a02-7d3e-4c85-b6a1-0e58d2f7c934", "", "e9bf5afe-8a5b-5d7c-9a28-2ffd8aa39bb5"],
    ]
  ) {
    test(id, async () => expect(await uuidV5(namespace, new TextEncoder().encode(name))).toStrictEqual(expected));
  }
});
