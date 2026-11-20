// Cards whose shells share one dock tab, listed next to each other: each bundle is a run of items in
// first-seen order; an item whose tab holds no other listed item stays a bundle of one.
export function bundle<T>(items: readonly T[], tabOf: (item: T) => string | undefined): T[][] {
  const count = new Map<string, number>();
  for (const it of items) {
    const t = tabOf(it);
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  const out: T[][] = [];
  const at = new Map<string, T[]>();
  for (const it of items) {
    const t = tabOf(it);
    if (!t || count.get(t)! < 2) {
      out.push([it]);
      continue;
    }
    const b = at.get(t);
    if (b) b.push(it);
    else {
      const fresh = [it];
      at.set(t, fresh);
      out.push(fresh);
    }
  }
  return out;
}
