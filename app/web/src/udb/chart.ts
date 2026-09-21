// `chart` view tabs: the config a tab carries and the transform that turns rows
// into marks. Pure — no React, no recharts — so `deno test` can reach it (Deno
// has no JSX types, so a test that touches a .tsx fails to type check).
import type { PropConfig, UdbProp, UdbRow } from "../api.ts";
import {
  type Agg,
  AGGREGATABLE,
  aggregate,
  type Group,
  groupRows,
} from "./view-core.ts";

export type ChartKind = "bar" | "line" | "pie";
// propId null + "count" is the row count — the one measure every database has,
// so a brand-new chart draws something before anything is configured.
export type ChartMeasure = Agg | "count";
export type ChartSeries = { propId: string | null; agg: ChartMeasure };
export type ChartConfig = {
  kind: ChartKind;
  x: string | null; // property to group by; null = one category per row
  series: ChartSeries[]; // index is the palette slot, never cycled
  stacked?: boolean; // bar, 2+ series
  donut?: boolean; // pie
  labels?: boolean; // value labels on the marks
};

export const CHART_KINDS: readonly ChartKind[] = ["bar", "line", "pie"];
export const CHART_AGGS: readonly Agg[] = ["sum", "avg", "min", "max"];
export const CHART_MEASURES: readonly ChartMeasure[] = ["count", ...CHART_AGGS];
export const KIND_LABEL: Record<ChartKind, string> = {
  bar: "Bar",
  line: "Line",
  pie: "Pie",
};

export const MAX_SERIES = 8; // palette slots; a 9th hue is indistinguishable
export const MAX_CATS = 24; // past this an x axis is unreadable
export const MAX_SLICES = 6; // a pie is part-to-whole at a glance, or nothing

// Series colors: a categorical palette validated for colour-blind separation and
// contrast against both Trame surfaces. The option palette is not usable here —
// its blue and purple are one colour to a protan eye.
export const CHART_COLORS: readonly string[] = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
  "var(--color-chart-7)",
  "var(--color-chart-8)",
];

// A tab config arrives from localStorage or the hub — neither is trusted.
// undefined degrades the tab to a plain table rather than throwing at render.
export function sanitizeChart(raw: unknown): ChartConfig | undefined {
  const c = raw as Partial<ChartConfig> | null;
  if (!c || typeof c !== "object") return undefined;
  if (!CHART_KINDS.includes(c.kind as ChartKind)) return undefined;
  if (!Array.isArray(c.series)) return undefined;
  const series = c.series.filter((s): s is ChartSeries =>
    !!s && typeof s === "object" &&
    CHART_MEASURES.includes((s as ChartSeries).agg)
  ).slice(0, MAX_SERIES).map((s) => ({
    propId: typeof s.propId === "string" ? s.propId : null,
    agg: s.agg,
  }));
  return {
    kind: c.kind as ChartKind,
    x: typeof c.x === "string" ? c.x : null,
    series,
    ...(c.stacked ? { stacked: true } : {}),
    ...(c.donut ? { donut: true } : {}),
    ...(c.labels ? { labels: true } : {}),
  };
}

// One row per category; "s0".."s7" hold the series values, which is the flat
// shape recharts reads through dataKey.
export type ChartRow = {
  x: string; // category label
  k: string; // group key, for React keys
  c?: string; // the category's own colour, when it has one (a select option)
  [series: string]: string | number | null | undefined;
};
export type ChartData = {
  rows: ChartRow[];
  series: { key: string; label: string; cfg: PropConfig }[];
  xLabel: string;
  hidden: number; // categories the cap dropped (pie folds instead)
};

const titleOf = (r: UdbRow, titleProp: UdbProp | undefined): string =>
  (titleProp ? String(r.vals[titleProp.id] ?? "") : "").trim() || "—";

export function chartData(
  rows: UdbRow[],
  props: UdbProp[],
  c: ChartConfig,
): ChartData {
  const byId = new Map(props.map((p) => [p.id, p]));
  const titleProp = props.find((p) => p.type === "title");
  const xProp = c.x ? byId.get(c.x) : undefined;

  // a deleted x column falls back to one category per row — the same "drop what
  // no longer resolves" rule applyView uses for filters and sorts
  const cats: Group[] = xProp ? groupRows(rows, xProp) : rows.map((r) => ({
    key: r.id,
    label: titleOf(r, titleProp),
    rows: [r],
  }));

  const series = c.series.slice(0, MAX_SERIES).map((s) => {
    if (s.agg === "count") return { prop: null, agg: null, cfg: {} };
    const p = s.propId ? byId.get(s.propId) : undefined;
    return p && AGGREGATABLE.has(p.type)
      ? { prop: p, agg: s.agg as Agg, cfg: p.config }
      : null;
  }).filter((s) => s !== null).map((s, i) => ({
    ...s,
    key: `s${i}`,
    label: s.prop ? `${s.prop.name} (${s.agg})` : "Count",
  }));

  let out: ChartRow[] = cats.map((g) => {
    const row: ChartRow = { x: g.label, k: g.key, c: g.color };
    for (const s of series) {
      // aggregate() returns null for an all-empty group — a gap, never a zero
      row[s.key] = s.prop ? aggregate(g.rows, s.prop, s.agg!) : g.rows.length;
    }
    return row;
  });

  let hidden = 0;
  const first = series[0]?.key;
  if (c.kind === "pie" && first) {
    // negative and empty categories are not part of any whole
    out = out.filter((r) => Number(r[first] ?? 0) > 0)
      .sort((a, b) => Number(b[first]) - Number(a[first]));
    if (out.length > MAX_SLICES) {
      const rest = out.slice(MAX_SLICES - 1);
      out = [...out.slice(0, MAX_SLICES - 1), {
        x: `Other (${rest.length})`,
        k: "\0other",
        [first]: rest.reduce((n, r) => n + Number(r[first] ?? 0), 0),
      }];
    }
  } else if (out.length > MAX_CATS) {
    hidden = out.length - MAX_CATS;
    out = out.slice(0, MAX_CATS);
  }

  return {
    rows: out,
    series: series.map(({ key, label, cfg }) => ({ key, label, cfg })),
    xLabel: xProp?.name ?? titleProp?.name ?? "",
    hidden,
  };
}
