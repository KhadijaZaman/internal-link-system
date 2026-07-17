import { useMemo, useState } from "react";
import { useGetGscOverview } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { MetricCard } from "@/components/gsc/metric-card";
import { TrendChart } from "@/components/gsc/trend-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

type Granularity = "daily" | "weekly";

interface Point {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function bucketWeekly(points: Point[]): Point[] {
  const buckets = new Map<string, { clicks: number; impressions: number; totalPosWeight: number; n: number; firstDate: string }>();
  for (const p of points) {
    const k = isoWeekKey(p.date);
    const b = buckets.get(k);
    if (b) {
      b.clicks += p.clicks;
      b.impressions += p.impressions;
      b.totalPosWeight += p.position * p.impressions;
      b.n += p.impressions;
      if (p.date < b.firstDate) b.firstDate = p.date;
    } else {
      buckets.set(k, {
        clicks: p.clicks,
        impressions: p.impressions,
        totalPosWeight: p.position * p.impressions,
        n: p.impressions,
        firstDate: p.date,
      });
    }
  }
  return Array.from(buckets.entries())
    .map(([k, b]) => ({
      date: k,
      clicks: b.clicks,
      impressions: b.impressions,
      ctr: b.impressions > 0 ? b.clicks / b.impressions : 0,
      position: b.n > 0 ? b.totalPosWeight / b.n : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function OverviewBody() {
  const { range } = useGscRange();
  const [gran, setGran] = useState<Granularity>("daily");
  const { data, isLoading, error } = useGetGscOverview({
    startDate: range.startDate,
    endDate: range.endDate,
    compare: range.compare,
    url: range.urlFilter ?? undefined,
  });

  const series = useMemo<Point[]>(() => {
    if (!data) return [];
    return gran === "weekly" ? bucketWeekly(data.timeseries) : data.timeseries;
  }, [data, gran]);

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="text-red-500 text-sm">Failed to load GSC overview.</div>;

  const t = data.totals;
  const d = data.deltaPct;
  const reversed = series.slice().reverse();

  return (
    <div className="space-y-6">
      <HowThisWorks
        summary="Headline GSC metrics — clicks, impressions, CTR, and average position — for the date range chosen above, with daily/weekly trend lines."
        steps={[
          { title: "Pick a date range", body: "Use the controls above. Range and URL filter persist across every GSC tab." },
          { title: "Read the totals + deltas", body: "Each KPI card shows the total for the period plus the percent change vs the previous period of the same length." },
          { title: "Watch the trend", body: "Toggle daily / weekly granularity to spot momentum or a step change." },
        ]}
        faqs={[
          { title: "Why is yesterday missing?", body: "Google Search Console has roughly a 24–48h reporting lag — the last 1–2 days are usually partial." },
          { title: "Are numbers deduped?", body: "Yes. Clicks and impressions are GSC's own deduplicated values for the chosen scope (origin or filtered URL)." },
        ]}
      />
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          Headline metrics
          <InfoTip>Totals for the selected date range with percent change vs the comparison period. Position uses inverted color logic — lower is better.</InfoTip>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Clicks" value={t.clicks} deltaPct={d?.clicks ?? null} />
          <MetricCard label="Impressions" value={t.impressions} deltaPct={d?.impressions ?? null} />
          <MetricCard label="CTR" value={t.ctr} format="percent" deltaPct={d?.ctr ?? null} />
          <MetricCard label="Avg Position" value={t.position} format="decimal" deltaPct={d?.position ?? null} inverted />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          Granularity
          <InfoTip>Switch the trend charts and breakdown table between daily and weekly buckets.</InfoTip>
        </span>
        {(["daily", "weekly"] as Granularity[]).map((g) => (
          <Button
            key={g}
            size="sm"
            variant={gran === g ? "default" : "outline"}
            onClick={() => setGran(g)}
            className="capitalize h-7"
          >
            {g}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground ml-auto">{series.length} buckets</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(["clicks", "impressions", "ctr", "position"] as const).map((m) => (
          <Card key={m} className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm capitalize flex items-center gap-1.5">
                {m}
                <InfoTip>Trend line for {m} over the selected range at the chosen granularity.</InfoTip>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TrendChart data={series} metric={m} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm capitalize flex items-center gap-1.5">
            {gran} breakdown
            <InfoTip>Raw {gran} numbers behind the charts. Shows the most recent 200 rows.</InfoTip>
          </CardTitle>
          <CopyButton
            disabled={reversed.length === 0}
            getText={() =>
              rowsToTsv(
                [gran === "weekly" ? "Week" : "Date", "Clicks", "Impressions", "CTR", "Position"],
                reversed.slice(0, 200).map((p) => [
                  p.date,
                  p.clicks,
                  p.impressions,
                  `${(p.ctr * 100).toFixed(2)}%`,
                  p.position.toFixed(1),
                ]),
              )
            }
          />
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left p-3">{gran === "weekly" ? "Week" : "Date"}</th>
                <th className="text-right p-3">Clicks</th>
                <th className="text-right p-3">Impressions</th>
                <th className="text-right p-3">CTR</th>
                <th className="text-right p-3">Position</th>
              </tr>
            </thead>
            <tbody>
              {reversed.slice(0, 200).map((p) => (
                <tr key={p.date} className="border-t hover:bg-muted/20">
                  <td className="p-3 font-mono text-xs">{p.date}</td>
                  <td className="p-3 text-right font-mono">{p.clicks}</td>
                  <td className="p-3 text-right font-mono">{p.impressions}</td>
                  <td className="p-3 text-right font-mono">{(p.ctr * 100).toFixed(2)}%</td>
                  <td className="p-3 text-right font-mono">{p.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GscOverviewPage() {
  return <GscLayout><OverviewBody /></GscLayout>;
}
