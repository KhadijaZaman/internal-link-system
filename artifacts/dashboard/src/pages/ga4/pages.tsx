import { useMemo, useState } from "react";
import { useGetGa4Pages } from "@workspace/api-client-react";
import { NotConnectedNotice, notConnectedProvider } from "@/components/not-connected-notice";
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
  | "avgEngagementTime"
  | "keyEvents"
  | "aiSessions";
type Preset = "28d" | "3mo" | "6mo" | "custom";
type Channel = "organic" | "all";

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
  const [channel, setChannel] = useState<Channel>("organic");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "sessions", dir: "desc" });

  const { data, isLoading, error } = useGetGa4Pages({ startDate, endDate, channel });

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
          Landing-page engagement from Google Analytics 4 — scoped to Organic Search by default,
          with key events (signups + demo bookings) and AI-assistant referrals per page.
          Refreshes automatically — cached for 30 minutes to protect API quota.
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
        <div className="flex gap-2 items-center">
          <Label className="text-xs text-muted-foreground">Traffic</Label>
          <Button
            size="sm"
            variant={channel === "organic" ? "default" : "outline"}
            onClick={() => setChannel("organic")}
          >
            Organic Search
          </Button>
          <Button
            size="sm"
            variant={channel === "all" ? "default" : "outline"}
            onClick={() => setChannel("all")}
          >
            All channels
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {startDate} → {endDate}
        </div>
      </div>

      <HowThisWorks
        summary="On-site engagement from GA4, per landing page. Engagement rate is the share of sessions that were 'engaged' — lasted 10s+, fired a conversion, or had 2+ pageviews. By default only Organic Search sessions are counted; switch to All channels to include everything."
        steps={[
          {
            title: "Pick a window and traffic scope",
            body: "Use the presets or a custom range. Organic Search (the default) matches how the rest of this dashboard thinks about SEO; All channels shows total traffic including paid, social, email, and direct.",
          },
          {
            title: "Sort & filter",
            body: "Sort by engagement rate to find sticky vs. weak pages, by key events to find pages that convert, or by AI sessions to see which pages AI assistants send visitors to.",
          },
          {
            title: "Read rate next to sessions",
            body: "A 100% rate on 5 sessions is noise. Always read engagement rate alongside the session count.",
          },
        ]}
        faqs={[
          {
            title: "Why does this differ from GSC Pages?",
            body: "GSC measures Google Search impressions and clicks. GA4 measures on-site behavior after the click — sessions here are grouped by the page a visitor landed on.",
          },
          {
            title: "What counts as an AI session?",
            body: "Sessions referred by AI assistants — ChatGPT, Claude, Perplexity, Gemini, and Copilot. These are counted across every channel, even in the Organic Search view.",
          },
          {
            title: "What is a key event?",
            body: "Signups and demo bookings, credited to the marketing page the visitor landed on at the start of their session — even though the signup itself happens later in the app. Sessions that start directly inside the app aren't counted here.",
          },
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error || !data ? (
        notConnectedProvider(error) ? (
          <NotConnectedNotice provider={notConnectedProvider(error)!} />
        ) : (
          <div className="py-12 text-center text-sm text-destructive">
            Failed to load GA4 data. {error instanceof Error ? error.message : ""}
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              label={channel === "organic" ? "Organic sessions" : "Sessions (all)"}
              value={data.totals.sessions.toLocaleString()}
            />
            <StatCard label="Engaged sessions" value={data.totals.engagedSessions.toLocaleString()} />
            <StatCard
              label="Engagement rate"
              value={`${(data.totals.engagementRate * 100).toFixed(1)}%`}
            />
            <StatCard
              label="Avg engagement / session"
              value={fmtTime(data.totals.avgEngagementTime)}
            />
            <StatCard label="Key events" value={data.totals.keyEvents.toLocaleString()} />
            <StatCard label="AI sessions" value={data.totals.aiSessions.toLocaleString()} />
          </div>

          <div className="flex gap-2 items-center">
            <InfoTip>
              Every landing page with at least one session, key event, or AI referral in this
              window.
            </InfoTip>
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
                  ["Path", "Engagement Rate", "Sessions", "Engaged Sessions", "Avg Engagement Time", "Key Events", "AI Sessions"],
                  rows.slice(0, 1000).map((r) => [
                    r.path,
                    `${(r.engagementRate * 100).toFixed(1)}%`,
                    r.sessions,
                    r.engagedSessions,
                    fmtTime(r.avgEngagementTime),
                    r.keyEvents,
                    r.aiSessions,
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
                    <SortableHeader col="avgEngagementTime" label="Avg Eng. Time" sort={sort} onChange={setSort} />
                    <SortableHeader col="keyEvents" label="Key Events" sort={sort} onChange={setSort} />
                    <SortableHeader col="aiSessions" label="AI Sessions" sort={sort} onChange={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 1000).map((r) => (
                    <tr key={r.path} className="border-t hover:bg-muted/20">
                      <td className="p-3 max-w-xl truncate text-primary">{r.path}</td>
                      <td className="p-3 text-right font-mono">{(r.engagementRate * 100).toFixed(1)}%</td>
                      <td className="p-3 text-right font-mono">{r.sessions.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{r.engagedSessions.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{fmtTime(r.avgEngagementTime)}</td>
                      <td className="p-3 text-right font-mono">{r.keyEvents.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono">{r.aiSessions.toLocaleString()}</td>
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
