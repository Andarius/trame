// Pure computations behind the Insights view: cost estimates, medians, weekly and hourly mixes.

// USD per million tokens: input, output, cache read; cache writes cost 1.25× input
type Price = { in: number; out: number; read: number };
// Anthropic list prices; most specific id first, since "claude-opus-5" prefixes "claude-opus-5-5"
const PRICES: [string, Price][] = [
  ["claude-fable-5-2", { in: 8, out: 40, read: 0.2 }],
  ["claude-mythos-5-2", { in: 8, out: 40, read: 0.2 }],
  ["claude-fable-5-1", { in: 10, out: 50, read: 1 }],
  ["claude-mythos-5-1", { in: 10, out: 50, read: 1 }],
  ["claude-fable-5", { in: 10, out: 50, read: 1 }],
  ["claude-opus-5-5", { in: 4, out: 20, read: 0.2 }],
  ["claude-opus-5", { in: 5, out: 25, read: 0.5 }],
  ["claude-opus-4", { in: 5, out: 25, read: 0.5 }],
  ["claude-sonnet-5-5", { in: 2, out: 10, read: 0.1 }],
  ["claude-sonnet-5", { in: 2, out: 10, read: 0.2 }],
  ["claude-sonnet-4", { in: 3, out: 15, read: 0.3 }],
  ["claude-haiku-5-5", { in: 0.1, out: 0.5, read: 0.01 }],
  ["claude-haiku-4", { in: 1, out: 5, read: 0.1 }],
];
const WRITE = 1.25;

export function priceOf(model: string | null): Price | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return PRICES.find(([id]) => m === id || m.startsWith(`${id}-`) || m.startsWith(`${id}[`))?.[1] ?? null;
}

// `tokens` is input + output with cache writes inside input and cache reads outside it
export type Usage = { m: string | null; tokens: number; out?: number; cached?: number; written?: number };

// estimated USD, or null for an unpriced model or a row without its token split (another device's)
export function costOf(u: Usage): number | null {
  const p = priceOf(u.m);
  if (!p || u.out === undefined || (u.tokens > 0 && !u.out && !u.cached)) return null;
  const written = u.written ?? 0;
  const input = u.tokens - u.out - written;
  return (input * p.in + written * p.in * WRITE + u.out * p.out + (u.cached ?? 0) * p.read) / 1e6;
}

// USD per kind of token: plain input, cache writes, cache reads, output
export type CostParts = { input: number; write: number; read: number; out: number };

export function costParts(rows: Usage[]): CostParts {
  const parts = { input: 0, write: 0, read: 0, out: 0 };
  for (const u of rows) {
    const p = priceOf(u.m);
    if (!p || costOf(u) === null) continue;
    const written = u.written ?? 0;
    parts.input += ((u.tokens - (u.out ?? 0) - written) * p.in) / 1e6;
    parts.write += (written * p.in * WRITE) / 1e6;
    parts.read += ((u.cached ?? 0) * p.read) / 1e6;
    parts.out += ((u.out ?? 0) * p.out) / 1e6;
  }
  return parts;
}

// spend this month so far, its straight-line projection to month end, and last month's total
export function burn(rows: (Usage & { d: string })[], today: string) {
  const month = today.slice(0, 7);
  const [y, m, d] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const sum = (prefix: string) => costSum(rows.filter((r) => r.d.startsWith(prefix))).usd;
  const mtd = sum(month);
  return { mtd, projected: (mtd / d) * days, last: sum(last) };
}

// total cost and the share of tokens it covers
export function costSum(rows: Usage[]): { usd: number; covered: number } {
  let usd = 0, priced = 0, all = 0;
  for (const r of rows) {
    all += r.tokens;
    const c = costOf(r);
    if (c === null) continue;
    usd += c;
    priced += r.tokens;
  }
  return { usd, covered: all ? priced / all : 1 };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Monday of a YYYY-MM-DD day's week, as YYYY-MM-DD
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

// tokens per bucket (a day, or the Monday of its week) and model; `keys` fixes the series, the rest fold into "other"
export function modelMix(
  rows: { d: string; m: string | null; tokens: number }[],
  keys: string[],
  bucket: (day: string) => string = weekOf,
) {
  const buckets = new Map<string, Map<string, number>>();
  let other = false;
  for (const r of rows) {
    if (!r.m || !r.tokens) continue;
    const b = bucket(r.d);
    const key = keys.includes(r.m) ? r.m : "other";
    other ||= key === "other";
    const cur = buckets.get(b) ?? new Map<string, number>();
    cur.set(key, (cur.get(key) ?? 0) + r.tokens);
    buckets.set(b, cur);
  }
  return {
    keys: other ? [...keys, "other"] : keys,
    buckets: [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

// models by total tokens, most used first; ranked over a stable window so colours don't follow the range
export function topModels(rows: { m: string | null; tokens: number }[], top = 5): string[] {
  const total = new Map<string, number>();
  for (const r of rows) if (r.m && r.tokens) total.set(r.m, (total.get(r.m) ?? 0) + r.tokens);
  return [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([m]) => m);
}

// heat level 0..4: 0 for none, then quartiles of the non-zero values, so one busy cell doesn't flatten the rest
export function heatLevels(values: number[]): (n: number) => number {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => nz[Math.floor(f * (nz.length - 1))] ?? 0);
  return (n) => (n <= 0 ? 0 : 1 + q.filter((t) => n > t).length);
}

// prompts per weekday (0 = Monday) and hour
export function hourGrid(rows: { d: string; h: number; n: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of rows) {
    const [y, m, d] = r.d.split("-").map(Number);
    grid[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7][r.h] += r.n;
  }
  return grid;
}

export const usd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(n >= 10 ? 1 : 2)}`;
