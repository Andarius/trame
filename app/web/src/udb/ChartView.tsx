// The chart body of a `chart` view tab. The only module that imports recharts,
// so the library lands in its own lazy chunk (DatabaseTable holds the boundary)
// and never reaches the main bundle.
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UdbProp, UdbRow } from "../api";
import {
  CHART_COLORS,
  type ChartConfig,
  chartData,
  type ChartRow,
  MAX_CATS,
  MAX_SLICES,
} from "./chart.ts";
import { fmtBare, fmtNumber } from "./cells";

const INK = "var(--color-ink-muted)";
const SURFACE = "var(--color-panel)";
const tick = { fill: INK, fontSize: 11 };
const legend = {
  wrapperStyle: { fontSize: 11.5, color: "var(--color-ink-soft)" },
  iconSize: 9,
  iconType: "rect" as const,
};
// recharts' default tooltip is a hardcoded white box — unreadable in dark mode
const tooltipStyle = {
  contentStyle: {
    background: "var(--color-panel-modal)",
    border: "1px solid var(--color-overlay-border)",
    borderRadius: 6,
    fontSize: 11.5,
  },
  labelStyle: { color: "var(--color-ink)", marginBottom: 2 },
  itemStyle: { color: "var(--color-ink-soft)" },
};
const slot = (i: number) => CHART_COLORS[i % CHART_COLORS.length];
const OTHER = "\0other"; // the folded pie wedge — neutral, not a palette slot

export default function ChartView(
  { rows, props, config }: {
    rows: UdbRow[];
    props: UdbProp[];
    config: ChartConfig;
  },
) {
  const data = useMemo(() => chartData(rows, props, config), [
    rows,
    props,
    config,
  ]);
  const { series } = data;
  const fmt = (v: unknown, key: string) =>
    fmtNumber(v, series.find((s) => s.key === key)?.cfg ?? {});

  if (!series.length) {
    return (
      <Empty>
        Pick what to measure in <Chip>▂▅ Chart</Chip>.
      </Empty>
    );
  }
  if (!data.rows.length) {
    return <Empty>No rows match the current filter.</Empty>;
  }

  // pie slices, and a lone bar series, wear the category's identity colour
  const byCategory = config.kind === "pie" || series.length === 1;
  const colorAt = (r: ChartRow, i: number) =>
    r.k === OTHER ? INK : (r.c ?? slot(i));

  // one axis, always: a series two orders of magnitude below the biggest draws
  // as nothing, and a second scale would be a lie — say so instead.
  const reach = series.map((s) =>
    Math.max(0, ...data.rows.map((r) => Math.abs(Number(r[s.key] ?? 0))))
  );
  const tallest = Math.max(...reach);
  const dwarfed = config.kind === "pie"
    ? []
    : series.filter((_, i) => reach[i] > 0 && reach[i] / tallest < 0.02);

  const grid = (
    <CartesianGrid vertical={false} stroke="var(--color-line-soft)" />
  );
  const axes = (
    <>
      <XAxis
        dataKey="x"
        tick={tick}
        tickLine={false}
        axisLine={{ stroke: "var(--color-line)" }}
        interval="preserveStartEnd"
      />
      <YAxis
        tick={tick}
        tickLine={false}
        axisLine={false}
        width={56}
        tickFormatter={(n: number) => fmtBare(n, series[0].cfg)}
      />
    </>
  );
  const tip = (
    <Tooltip
      {...tooltipStyle}
      cursor={{ fill: "var(--color-hover)" }}
      formatter={(v: unknown, _n: unknown, item: unknown) =>
        fmt(v, String((item as { dataKey?: unknown })?.dataKey ?? ""))}
    />
  );

  return (
    <div className="max-w-[900px] rounded-lg border border-line-soft bg-panel p-3">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {config.kind === "pie"
            ? (
              <PieChart>
                <Pie
                  data={data.rows}
                  dataKey={series[0].key}
                  nameKey="x"
                  innerRadius={config.donut ? "56%" : 0}
                  outerRadius="78%"
                  paddingAngle={1}
                  stroke={SURFACE}
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {data.rows.map((r, i) => (
                    // the folded "Other" wedge is deliberately neutral, not a slot
                    <Cell key={r.k} fill={colorAt(r, i)} />
                  ))}
                </Pie>
                <Tooltip
                  {...tooltipStyle}
                  formatter={(v: unknown) => fmt(v, series[0].key)}
                />
                <Legend {...legend} />
              </PieChart>
            )
            : config.kind === "line"
            ? (
              <LineChart
                data={data.rows}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
              >
                {grid}
                {axes}
                {tip}
                {series.length > 1 && <Legend {...legend} />}
                {series.map((s, i) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={slot(i)}
                    strokeWidth={2}
                    // recharts fills a dot white by default — invisible on the
                    // light panel; the surface ring keeps overlaps readable
                    dot={{
                      r: 4,
                      strokeWidth: 2,
                      stroke: SURFACE,
                      fill: slot(i),
                    }}
                    activeDot={{ r: 5 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )
            : (
              <BarChart
                data={data.rows}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
              >
                {grid}
                {axes}
                {tip}
                {series.length > 1 && <Legend {...legend} />}
                {series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={slot(i)}
                    maxBarSize={28}
                    radius={config.stacked ? 0 : [4, 4, 0, 0]}
                    stackId={config.stacked ? "a" : undefined}
                    // 2px of surface between stacked segments
                    stroke={config.stacked ? SURFACE : undefined}
                    strokeWidth={config.stacked ? 2 : 0}
                    isAnimationActive={false}
                  >
                    {
                      /* a lone series takes each category's own colour when it
                        has one — a select column already carries identity */
                    }
                    {series.length === 1 &&
                      data.rows.map((r, j) => (
                        <Cell key={r.k} fill={r.c ?? slot(j)} />
                      ))}
                  </Bar>
                ))}
              </BarChart>
            )}
        </ResponsiveContainer>
      </div>

      {/* the numbers behind the marks — the readable fallback a chart owes */}
      <div className="mt-3 overflow-x-auto border-t border-line-soft pt-2">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-ink-muted">
              <th className="py-1 pr-3 text-left font-medium">{data.xLabel}</th>
              {series.map((s, i) => (
                <th
                  key={s.key}
                  className="py-1 pl-3 text-right font-medium whitespace-nowrap"
                >
                  {!byCategory && (
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-[2px] align-middle"
                      style={{ background: slot(i) }}
                    />
                  )}
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, ri) => (
              <tr key={r.k} className="border-t border-line-soft">
                <td className="truncate py-1 pr-3 text-ink-soft">
                  {byCategory && (
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-[2px] align-middle"
                      style={{ background: colorAt(r, ri) }}
                    />
                  )}
                  {r.x}
                </td>
                {series.map((s) => (
                  <td
                    key={s.key}
                    className="py-1 pl-3 text-right tabular-nums text-ink"
                  >
                    {r[s.key] == null ? "—" : fmt(r[s.key], s.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dwarfed.length > 0 && (
        <p className="mt-2 text-[11px] text-ink-muted/70">
          {dwarfed.map((s) => s.label).join(", ")}{" "}
          {dwarfed.length > 1 ? "are" : "is"} too small to read beside{" "}
          {series[reach.indexOf(tallest)]?.label}{" "}
          — a second scale would distort it, so chart it on its own instead.
        </p>
      )}
      {data.hidden > 0 && (
        <p className="mt-2 text-[11px] text-ink-muted/70">
          Showing the first {MAX_CATS} of {MAX_CATS + data.hidden}{" "}
          groups — add a filter to narrow it.
        </p>
      )}
      {config.kind === "pie" && data.rows.some((r) => r.k === OTHER) && (
        <p className="mt-2 text-[11px] text-ink-muted/70">
          A pie reads at a glance up to {MAX_SLICES}{" "}
          slices; the rest are folded into Other.
        </p>
      )}
    </div>
  );
}

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="text-ink-soft">{children}</span>
);
const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="px-1 py-8 text-[13px] text-ink-muted">{children}</div>
);
