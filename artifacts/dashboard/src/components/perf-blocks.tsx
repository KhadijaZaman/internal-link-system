import { useMemo } from "react";
import type {
  GscMetricsTotals,
  GscTimeseriesPoint,
} from "@workspace/api-client-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

export const RANGE_OPTIONS = [
  { value: "14", label: "Last 14 days" },
  { value: "28", label: "Last 28 days" },
  { value: "90", label: "Last 90 days" },
];

// GSC uses ISO 3166-1 alpha-3 country codes (lowercase).
export const COUNTRY_OPTIONS = [
  { value: "all", label: "Worldwide" },
  { value: "usa", label: "United States" },
  { value: "gbr", label: "United Kingdom" },
  { value: "ind", label: "India" },
  { value: "can", label: "Canada" },
  { value: "aus", label: "Australia" },
  { value: "deu", label: "Germany" },
  { value: "fra", label: "France" },
  { value: "nld", label: "Netherlands" },
  { value: "esp", label: "Spain" },
  { value: "ita", label: "Italy" },
  { value: "bra", label: "Brazil" },
  { value: "jpn", label: "Japan" },
  { value: "sgp", label: "Singapore" },
  { value: "are", label: "UAE" },
  { value: "phl", label: "Philippines" },
  { value: "idn", label: "Indonesia" },
  { value: "pak", label: "Pakistan" },
  { value: "nga", label: "Nigeria" },
  { value: "zaf", label: "South Africa" },
];

export function fmtPos(p: number): string {
  return p > 0 ? p.toFixed(1) : "—";
}

export function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)}`;
}

export function fmtDayFull(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Day-over-day cell color: green = improved, red = declined, no color when
// unchanged or when either day has no data.
export function dayCellClass(
  curr: number | null,
  prev: number | null,
  lowerIsBetter = false,
): string {
  if (curr == null || prev == null || curr === prev) return "";
  const improved = lowerIsBetter ? curr < prev : curr > prev;
  return improved
    ? "text-emerald-600 dark:text-emerald-400 font-medium"
    : "text-red-600 dark:text-red-400 font-medium";
}

export function DayTable({ series, title }: { series: GscTimeseriesPoint[]; title: string }) {
  const rows = useMemo(() => {
    const mapped = series.map((p, i) => {
      const prev = i > 0 ? series[i - 1] : null;
      const pos = p.position > 0 ? Number(p.position.toFixed(1)) : null;
      const prevPos =
        prev && prev.position > 0 ? Number(prev.position.toFixed(1)) : null;
      return {
        date: p.date,
        pos,
        posCls: dayCellClass(pos, prevPos, true),
        impressions: p.impressions,
        imprCls: dayCellClass(p.impressions, prev ? prev.impressions : null),
        clicks: p.clicks,
        clicksCls: dayCellClass(p.clicks, prev ? prev.clicks : null),
      };
    });
    return mapped.reverse(); // newest day first
  }, [series]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-sm text-muted-foreground border border-dashed rounded-lg">
        No Search Console data for this range
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10">
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium text-right">Avg position</th>
                <th className="px-3 py-2 font-medium text-right">Impressions</th>
                <th className="px-3 py-2 font-medium text-right">Clicks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.date}>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                    {fmtDayFull(r.date)}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.posCls}`}>
                    {r.pos != null ? r.pos.toFixed(1) : "—"}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.imprCls}`}>
                    {r.impressions.toLocaleString()}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.clicksCls}`}>
                    {r.clicks.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground mt-1">
        Compared with the previous day:{" "}
        <span className="text-emerald-600 dark:text-emerald-400">green = uplift</span>
        {" · "}
        <span className="text-red-600 dark:text-red-400">red = decline</span>
        {" · "}no color = unchanged. For position, lower is better.
      </div>
    </div>
  );
}

export function Delta({
  current,
  previous,
  lowerIsBetter,
  digits = 0,
}: {
  current: number;
  previous: number | null | undefined;
  lowerIsBetter?: boolean;
  digits?: number;
}) {
  if (previous == null || previous === 0) {
    return <span className="text-xs text-muted-foreground">vs prev: —</span>;
  }
  const diff = current - previous;
  if (Math.abs(diff) < Math.pow(10, -digits) / 2) {
    return (
      <span className="text-xs text-muted-foreground inline-flex items-center gap-0.5">
        <Minus className="h-3 w-3" /> no change
      </span>
    );
  }
  const improved = lowerIsBetter ? diff < 0 : diff > 0;
  const Icon = diff > 0 ? ArrowUp : ArrowDown;
  const cls = improved
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
  const abs = Math.abs(diff);
  return (
    <span className={`text-xs inline-flex items-center gap-0.5 ${cls}`}>
      <Icon className="h-3 w-3" />
      {digits > 0 ? abs.toFixed(digits) : Math.round(abs).toLocaleString()} vs prev
    </span>
  );
}

export function MetricCard({
  label,
  value,
  totals,
  prev,
  metric,
}: {
  label: string;
  value: string;
  totals: GscMetricsTotals | null;
  prev: GscMetricsTotals | null | undefined;
  metric: "clicks" | "impressions" | "position";
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums mt-0.5">{value}</div>
      <div className="mt-0.5">
        {totals ? (
          <Delta
            current={totals[metric]}
            previous={prev ? prev[metric] : null}
            lowerIsBetter={metric === "position"}
            digits={metric === "position" ? 1 : 0}
          />
        ) : (
          <span className="text-xs text-muted-foreground">no data</span>
        )}
      </div>
    </div>
  );
}

export function TrendChart({ series, title }: { series: GscTimeseriesPoint[]; title: string }) {
  const data = useMemo(
    () =>
      series.map((p) => ({
        date: fmtDate(p.date),
        position: p.position > 0 ? Number(p.position.toFixed(1)) : null,
        impressions: p.impressions,
        clicks: p.clicks,
      })),
    [series],
  );
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border border-dashed rounded-lg">
        No Search Console data for this range
      </div>
    );
  }
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis
              yAxisId="impr"
              tick={{ fontSize: 10 }}
              allowDecimals={false}
              width={44}
            />
            <YAxis
              yAxisId="pos"
              orientation="right"
              reversed
              domain={["auto", "auto"]}
              tick={{ fontSize: 10 }}
              width={34}
            />
            <Tooltip
              formatter={(value: unknown, name: string): [string, string] => {
                if (name === "Position") {
                  return [value == null ? "—" : String(value), "Position"];
                }
                return [Number(value).toLocaleString(), name];
              }}
              contentStyle={{ fontSize: 12 }}
            />
            <Bar
              yAxisId="impr"
              dataKey="impressions"
              name="Impressions"
              fill="hsl(var(--primary) / 0.25)"
              radius={[2, 2, 0, 0]}
            />
            <Bar
              yAxisId="impr"
              dataKey="clicks"
              name="Clicks"
              fill="hsl(var(--primary))"
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="pos"
              type="monotone"
              dataKey="position"
              name="Position"
              stroke="hsl(var(--destructive))"
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[11px] text-muted-foreground mt-1">
        Bars = impressions & clicks (left axis) · Red line = average position, lower is
        better (right axis, inverted)
      </div>
    </div>
  );
}
