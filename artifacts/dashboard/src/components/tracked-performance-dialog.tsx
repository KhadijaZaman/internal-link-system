import { useMemo, useState } from "react";
import {
  useGetTrackedSubmissionPerformance,
  getGetTrackedSubmissionPerformanceQueryKey,
  useUpdateTrackedSubmission,
  getListTrackedSubmissionsQueryKey,
  type GscMetricsTotals,
  type GscTimeseriesPoint,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ArrowDown, ArrowUp, Minus, Search, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const RANGE_OPTIONS = [
  { value: "14", label: "Last 14 days" },
  { value: "28", label: "Last 28 days" },
  { value: "90", label: "Last 90 days" },
];

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

function fmtPos(p: number): string {
  return p > 0 ? p.toFixed(1) : "—";
}

function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)}`;
}

function Delta({
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

function MetricCard({
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

function TrendChart({ series, title }: { series: GscTimeseriesPoint[]; title: string }) {
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

export function TrackedPerformanceDialog({
  trackedId,
  url,
  keyword,
  open,
  onOpenChange,
}: {
  trackedId: number;
  url: string;
  keyword: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [days, setDays] = useState("28");
  // The prop is a snapshot from the list; keep the live value locally so the
  // header updates immediately after an in-dialog save.
  const [effectiveKeyword, setEffectiveKeyword] = useState<string | null>(keyword);
  const [keywordDraft, setKeywordDraft] = useState(keyword ?? "");
  const [editingKeyword, setEditingKeyword] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateTrackedSubmission();

  const perfQ = useGetTrackedSubmissionPerformance(
    trackedId,
    { days: Number(days) },
    {
      query: {
        queryKey: getGetTrackedSubmissionPerformanceQueryKey(trackedId, {
          days: Number(days),
        }),
        enabled: open,
        staleTime: 5 * 60 * 1000,
        retry: 1,
      },
    },
  );

  const saveKeyword = () => {
    const next = keywordDraft.trim();
    updateMutation.mutate(
      { id: trackedId, data: { keyword: next.length > 0 ? next : null } },
      {
        onSuccess: () => {
          setEffectiveKeyword(next.length > 0 ? next : null);
          setEditingKeyword(false);
          toast({ title: next ? `Keyword set: “${next}”` : "Keyword cleared" });
          queryClient.invalidateQueries({
            queryKey: getListTrackedSubmissionsQueryKey(),
          });
          // Path-only key: invalidates every cached days-range for this URL.
          queryClient.invalidateQueries({
            queryKey: [`/api/tracked-submissions/${trackedId}/performance`],
          });
        },
        onError: () =>
          toast({ variant: "destructive", title: "Couldn't save keyword" }),
      },
    );
  };

  const d = perfQ.data;
  const trackedShare =
    d && d.keywordTotals && d.overallTotals.impressions > 0
      ? (d.keywordTotals.impressions / d.overallTotals.impressions) * 100
      : null;
  const topQuery = d && d.topQueries.length > 0 ? d.topQueries[0] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
            {pathOf(url)}
          </DialogTitle>
          <DialogDescription className="text-xs break-all">{url}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {editingKeyword || !effectiveKeyword ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveKeyword();
                }}
              >
                <Input
                  value={keywordDraft}
                  onChange={(e) => setKeywordDraft(e.target.value)}
                  placeholder="Target keyword, e.g. best ai visibility tools"
                  className="h-8 w-72 text-sm"
                />
                <Button type="submit" size="sm" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : "Save"}
                </Button>
                {effectiveKeyword && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingKeyword(false);
                      setKeywordDraft(effectiveKeyword);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </form>
            ) : (
              <>
                <Badge variant="secondary" className="gap-1 max-w-[22rem] truncate">
                  <Search className="h-3 w-3" /> {effectiveKeyword}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setKeywordDraft(effectiveKeyword);
                    setEditingKeyword(true);
                  }}
                >
                  Edit
                </Button>
              </>
            )}
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {perfQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-6 w-6" />
          </div>
        ) : perfQ.isError ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Couldn't load Search Console data. Try again in a moment.
          </div>
        ) : d ? (
          <div className="space-y-5">
            {d.keyword && (
              <section>
                <div className="text-sm font-semibold mb-2">
                  Tracked keyword · “{d.keyword}”
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <MetricCard
                    label="Impressions"
                    value={(d.keywordTotals?.impressions ?? 0).toLocaleString()}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="impressions"
                  />
                  <MetricCard
                    label="Clicks"
                    value={(d.keywordTotals?.clicks ?? 0).toLocaleString()}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="clicks"
                  />
                  <MetricCard
                    label="Avg position"
                    value={fmtPos(d.keywordTotals?.position ?? 0)}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="position"
                  />
                </div>
                <div className="mt-3">
                  <TrendChart
                    series={d.keywordSeries}
                    title="Day-by-day: keyword position, impressions & clicks"
                  />
                </div>
              </section>
            )}

            <section>
              <div className="text-sm font-semibold mb-2">
                Whole page (all queries)
                {trackedShare != null && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    tracked keyword = {trackedShare.toFixed(1)}% of page impressions
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MetricCard
                  label="Impressions"
                  value={d.overallTotals.impressions.toLocaleString()}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="impressions"
                />
                <MetricCard
                  label="Clicks"
                  value={d.overallTotals.clicks.toLocaleString()}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="clicks"
                />
                <MetricCard
                  label="Avg position"
                  value={fmtPos(d.overallTotals.position)}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="position"
                />
              </div>
              {!d.keyword && (
                <div className="mt-3">
                  <TrendChart
                    series={d.overallSeries}
                    title="Day-by-day: page position, impressions & clicks"
                  />
                </div>
              )}
            </section>

            <section>
              <div className="text-sm font-semibold mb-2">
                Top queries for this page
                {topQuery && !topQuery.isTracked && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    top query: “{topQuery.query}”
                  </span>
                )}
              </div>
              {d.topQueries.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No query data in this range.
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
                        <th className="px-3 py-2 font-medium">Query</th>
                        <th className="px-3 py-2 font-medium text-right">Impressions</th>
                        <th className="px-3 py-2 font-medium text-right">Clicks</th>
                        <th className="px-3 py-2 font-medium text-right">CTR</th>
                        <th className="px-3 py-2 font-medium text-right">Position</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {d.topQueries.map((q) => (
                        <tr
                          key={q.query}
                          className={q.isTracked ? "bg-cyan-500/5" : undefined}
                        >
                          <td className="px-3 py-1.5">
                            <span className="inline-flex items-center gap-1.5">
                              {q.query}
                              {q.isTracked && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0 gap-0.5"
                                >
                                  <Target className="h-2.5 w-2.5" /> tracked
                                </Badge>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {q.impressions.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {q.clicks.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {(q.ctr * 100).toFixed(2)}%
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmtPos(q.position)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="text-[11px] text-muted-foreground">
              {d.startDate} → {d.endDate} · Search Console data (lags ~2 days) · shifts
              compare against the preceding {days}-day window · cached 30 min
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
