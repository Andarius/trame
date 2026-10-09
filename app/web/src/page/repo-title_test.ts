import { assertEquals } from "@std/assert";
import { repoTitle } from "./repo-title.ts";

for (
  const [id, title, want] of [
    ["repo prefix", "sre-config — pgaudit on the cnpg clusters", { repo: "sre-config", title: "pgaudit on the cnpg clusters" }],
    ["ticket ref stays", "GEN-7382 — Accès GitHub", { repo: null, title: "GEN-7382 — Accès GitHub" }],
    ["multi-word lead is not a repo", "Soren target infra — telemetry", { repo: null, title: "Soren target infra — telemetry" }],
    ["no separator", "Product tools", { repo: null, title: "Product tools" }],
  ] as const
) {
  Deno.test(`repoTitle: ${id}`, () => assertEquals(repoTitle({ title }), want));
}
