import { assertEquals } from "@std/assert";
import { allowedEmbedHost } from "./embed.ts";

const HOSTS = ["grafana.saas-ops.galactix.ninja"];

for (
  const [id, url, hosts, want] of [
    ["allowlisted https host", "https://grafana.saas-ops.galactix.ninja/d/abc?kiosk", HOSTS, "grafana.saas-ops.galactix.ninja"],
    ["port kept in the label", "https://grafana.saas-ops.galactix.ninja:3000/d/abc", HOSTS, "grafana.saas-ops.galactix.ninja:3000"],
    ["host case ignored", "https://GRAFANA.saas-ops.galactix.ninja/d/abc", [" Grafana.saas-ops.galactix.ninja "], "grafana.saas-ops.galactix.ninja"],
    ["empty allowlist disables embeds", "https://grafana.saas-ops.galactix.ninja/", [], null],
    ["host not on the list", "https://evil.example/", HOSTS, null],
    ["suffix lookalike", "https://grafana.saas-ops.galactix.ninja.evil.example/", HOSTS, null],
    ["userinfo trick", "https://grafana.saas-ops.galactix.ninja@evil.example/", HOSTS, null],
    ["http refused", "http://grafana.saas-ops.galactix.ninja/", HOSTS, null],
    ["javascript scheme", "javascript:alert(1)", HOSTS, null],
    ["not a url", "grafana", HOSTS, null],
  ] as const
) {
  Deno.test(`allowedEmbedHost: ${id}`, () => {
    assertEquals(allowedEmbedHost(url, hosts), want);
  });
}
