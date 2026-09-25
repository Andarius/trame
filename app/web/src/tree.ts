// The session tree model, shared by the web app and tramecli (no React here).
export type TreePage = { id: string; parent_id: string | null; kind: string; title: string; icon: string | null };

// ancestor walk with a hop cap: parent_id has no FK, sync can deliver odd states
export function* ancestry<P extends TreePage>(start: P | undefined, byId: Map<string, P>): Generator<P> {
  let p = start;
  for (let hops = 0; p && hops < 20; hops++) {
    yield p;
    p = p.parent_id ? byId.get(p.parent_id) : undefined;
  }
}

export const pagesById = <P extends TreePage>(pages: P[]) => new Map(pages.map((p) => [p.id, p]));

// The anchor: the exact page a session is attached to.
export function sessionAnchor<P extends TreePage>(
  s: { page_id: string | null },
  byId: Map<string, P>,
): P | undefined {
  return s.page_id ? byId.get(s.page_id) : undefined;
}

// story = nearest story ancestor of the anchor (or the anchor itself); may be none.
export function storyOf<P extends TreePage>(
  s: { page_id: string | null },
  byId: Map<string, P>,
): P | undefined {
  for (const p of ancestry(sessionAnchor(s, byId), byId)) if (p.kind === "story") return p;
  return undefined;
}

// project = nearest project ancestor; client_id is only the fallback for sessions with no page.
export function projectOf<P extends TreePage>(
  s: { page_id: string | null; client_id: string | null },
  byId: Map<string, P>,
): string | null {
  for (const p of ancestry(sessionAnchor(s, byId), byId)) if (p.kind === "project") return p.id;
  return s.client_id;
}

// Subtree semantics: a session matches a filter page when its anchor is that page
// or sits anywhere under it.
export function inSubtree<P extends TreePage>(
  s: { page_id: string | null },
  rootId: string,
  byId: Map<string, P>,
): boolean {
  for (const p of ancestry(sessionAnchor(s, byId), byId)) if (p.id === rootId) return true;
  return false;
}

export function sessionTagKeys<P extends TreePage & { tags?: string[] }>(
  s: { page_id: string | null; tags?: string[] },
  byId: Map<string, P>,
): string[] {
  const page = storyOf(s, byId) ?? sessionAnchor(s, byId);
  return [...new Set([...(s.tags ?? []), ...(page?.tags ?? [])])];
}

export function matchesSessionFilter<P extends TreePage & { tags?: string[] }>(
  s: { page_id: string | null; tags?: string[] },
  filter: string,
  byId: Map<string, P>,
): boolean {
  return filter.startsWith("tag:")
    ? sessionTagKeys(s, byId).includes(filter.slice(4))
    : inSubtree(s, filter, byId);
}
