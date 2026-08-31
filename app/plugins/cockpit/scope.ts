// Project mappings: which Cockpit scope mirrors into which Trame project.
//
// This is the whole privacy story of the plugin. An empty list syncs nothing,
// and nothing outside a mapping is ever requested — enabling the plugin must
// not pull a team's entire tracker into a local database that syncs to a hub
// and whose pages can be shared by public link.

export type Mapping = {
  // Exactly one of the two, mirroring Cockpit's own scope vocabulary.
  product?: string;
  flow?: string;
  // Trame project page the mirrored stories live under. Empty until phase 3
  // needs it; the editor collects it now so the mapping is complete.
  pageId: string;
};

export type Scope = { kind: "product" | "flow"; slug: string };

const SLUG_RE = /^[a-z0-9_-]+$/;

/** The Cockpit scope a mapping addresses, or null when it is malformed. */
export function scopeOf(m: Mapping): Scope | null {
  const product = m.product?.trim() ?? "";
  const flow = m.flow?.trim() ?? "";
  // Both set is ambiguous and the server rejects it — refuse locally too, so a
  // bad mapping fails in the settings pane rather than every poll.
  if (product && flow) return null;
  if (product) {
    return SLUG_RE.test(product) ? { kind: "product", slug: product } : null;
  }
  if (flow) return SLUG_RE.test(flow) ? { kind: "flow", slug: flow } : null;
  return null;
}

/** Query string for the sync API. */
export function scopeQuery(s: Scope): string {
  return `${s.kind}=${encodeURIComponent(s.slug)}`;
}

/** Stable key for a mapping — its scope. Used to key watermarks and state. */
export function scopeKey(s: Scope): string {
  return `${s.kind}:${s.slug}`;
}

/**
 * Read mappings out of the settings slice, dropping anything malformed.
 *
 * Fail-closed on purpose: an unreadable row removes a mapping, it never adds
 * one, and it can never widen a scope.
 */
export function parseMappings(raw: unknown): Mapping[] {
  if (!Array.isArray(raw)) return [];
  const out: Mapping[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const m: Mapping = {
      product: typeof e.product === "string" ? e.product.trim() : undefined,
      flow: typeof e.flow === "string" ? e.flow.trim() : undefined,
      pageId: typeof e.pageId === "string" ? e.pageId.trim() : "",
    };
    const scope = scopeOf(m);
    if (!scope) continue;
    // Two mappings on the same scope would poll it twice and fight over the
    // same watermark; the second is dropped rather than silently merged.
    const key = scopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
