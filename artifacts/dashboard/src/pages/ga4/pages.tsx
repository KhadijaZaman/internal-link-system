import { useMemo, useState } from "react";
import { useGetGa4Pages } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SortableHeader, type SortState } from "@/components/gsc/sortable-header";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

type SortKey =
  | "path"
  | "engagementRate"
  | "sessions"
  | "engagedSessions"
  | "screenPageViews"
  | "avgEngagementTime";
type Preset = "28d" | "3mo" | "6mo" | "custom";

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function presetRange(p: Exclude<Preset, "custom">): { startDate: string; endDate: string } {
  const endDate = dateOffset(1);
  if (p === "28d") return { startDate: dateOffset(28), endDate };
  if (p === "3mo") return { startDate: dateOffset(90), endDate };
  return { startDate: dateOffset(180), endDate };
}

function fmtTime(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

const PRESETS: [Preset, string][] = [
  ["28d", "Last 28 days"],
  ["3mo", "3 months"],
  ["6mo", "6 months"],
  ["custom", "Custom"],
];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-display mt-1">{value}</div>
    </div>
  );
}

export default function Ga4PagesPage() {
  const initial = presetRange("28d");
  const [preset, setPreset] = useState<Preset>("28d");
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "sessions", dir: "desc" });

  const { data, isLoading, error } = useGetGa4Pages({ startDate, endDate });

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.rows.filter((r) =>
      search ? r.path.toLowerCase().includes(search.toLowerCase()) : true,
    );
    return filtered.slice().sort((a, b) => {
      const av = a[sort.key] as string | number;
      const bv = b[sort.key] as string | number;
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data, search, sort]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setStartDate(r.startDate);
      setEndDate(r.endDate);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-3xl font-display text-foreground">GA4 Engagement</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Page-by-page engagement rate, sessions, and average engagement time from Google
          Analytics 4. Refreshes automatically — cached for 30 minutes to protect API quota.
        </p>
      </div>

      <div className="border rounded-lg p-4 bg-card flex flex-col lg:flex-row gap-4 lg:items-end flex-wrap">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(([v, l]) => (
            <Button
              key={v}
              size="sm"
              variant={preset === v ? "default" : "outline"}
              onClick={() => applyPreset(v)}
            >
              {l}
            </Button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex gap-2 items-end">
            <div>
              <Label className="text-xs text-muted-foreground">Start</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">End</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {startDate} → {endDate}
        </div>
      </div>

      <HowThisWorks
        summary="On-site engagement from GA4, per page. Engagement rate is the share of sessions that were 'engaged' — lasted 10s+, fired a conversion, or had 2+ pageviews."
        steps={[
          {
            title: "Pick a window",
            body: "Use the presets or a custom range. GA4 keeps full history, so you can look back months — unlike the 28-day-limited live feeds.",
          },
          {
            title: "Sort & filter",
            body: "Sort by engagement rate to find sticky vs. weak pages, or by sessions to weight by traffic. Filter by path to focus on a section.",
          },
          {
            title: "Read rate next to sessions",
            body: "A 100% rate on 5 sessions is noise. Always read engagement rate alongside the session count.",
          },
        ]}
        faqs={[
          {
            title: "Why does this differ from GSC Pages?",
            body: "GSC measures Google Search impressions and clicks. GA4 measures on-site behavior across every traffic source after the click.",
          },
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error || !data ? (
        <div className="py-12 text-center text-sm text-destructive">
          Failed to load GA4 data. {error instanceof Error ? error.message : ""}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Sessions" value={data.totals.sessions.toLocaleString()} />
            <StatCard label="Engaged sessions" value={data.totals.engagedSessions.toLocaleString()} />
            <StatCard
              label="Engagement rate"
              value={`${(data.totals.engagementRate * 100).toFixed(1)}%`}
            />
            <StatCard
              label="Avg engagement / session"
              value={fmtTime(data.totals.avgEngagementTime)}
            />
          </div>

          <div className="flex gap-2 items-center">
            <InfoTip>Every page with at least one session in this window.</InfoTip>
            <Input
              placeholder="Filter path..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-md h-9"
            />
            <div className="text-xs text-muted-foreground ml-auto">{rows.length} pages</div>
            <CopyButton
              disabled={rows.length === 0}
              getText={() =>
                rowsToTsv(
                  ["Path", "Engagement Rate", "Sessions", "Engaged Sessions", "Views", "Avg Engagement Time"],
                  rows.slice(0, 1000).map((r) => [
                    r.path,
                    `${(r.engagementRate * 100).toFixed(1)}%`,
                    r.sessions,
                    r.engagedSessions,
                    r.screenPageViews,
                    fmtTime(r.avgEngagementTime),
                  ]),
                )
              }
            />
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <SortableHeader col="path" label="Path" sort={sort} onChange={setSort} align="left" />
                    <SortableHeader col="engagementRate" label="Engagement Rate" sort={sort} onChange={setSort} />
                    <SortableHeader col="sessions" label="Sessions" sort={sort} onChange={setSort} />
                    <SortableHeader col="engagedSessions" label="Engaged" sort={sort} onChange={setSort} />
                    <SortableHeader col="screenPageViews" label="Views" sort={sort} onChange={setSort} />
                    <SortableHeader col="avgEngagementTime" label="Avg Eng. Time" sort={sort} onChange={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 1000).map((r) => (
                    <tr key={r.path} className="border-t hover:bg-muted/20">
                      <td className="p-3 max-w-xl truncate text-primary">{r.path}</td>
                      <td className="p-3 text-right font-mono">{(r.engagementRate * 100).toFixed(1)}%</td>
                      <td className="p-3 text-right font-mono">{r.sessions.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{r.engagedSessions.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{r.screenPageViews.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{fmtTime(r.avgEngagementTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
