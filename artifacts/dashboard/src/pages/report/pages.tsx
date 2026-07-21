import { Fragment, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useGetPagesReport, type PageReportRowVerdictsItem } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SortableHeader, type SortState } from "@/components/gsc/sortable-header";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { DataNarrative, Num } from "@/components/data-narrative";
import { rowsToTsv } from "@/lib/clipboard";

type SortKey =
  | "path"
  | "position"
  | "impressions"
  | "clicks"
  | "engagementRate"
  | "sessions"
  | "avgEngagementTime"
  | "keyEvents"
  | "aiSessions"
  | "queryCount";
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

const PRESETS: [Preset, string][] = [
  ["28d", "Last 28 days"],
  ["3mo", "3 months"],
  ["6mo", "6 months"],
  ["custom", "Custom"],
];

function pos(n: number, impressions: number): string {
  return impressions > 0 ? n.toFixed(1) : "—";
}

function rate(n: number, sessions: number): string {
  return sessions > 0 ? `${(n * 100).toFixed(1)}%` : "—";
}

function fmtTime(sec: number, sessions: number): string {
  if (sessions <= 0) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

const VERDICT_META: Record<
  PageReportRowVerdictsItem,
  { label: string; tip: string; className: string }
> = {
  low_ctr: {
    label: "Low CTR",
    tip: "Ranks in the top 10 but earns far fewer clicks than pages at this position usually get — the title/snippet is losing the click.",
    className:
      "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
  },
  weak_engagement: {
    label: "Weak engagement",
    tip: "Google ranks this page well, but under 40% of visitors engage — the content isn't delivering what the search promised.",
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
  no_conversions: {
    label: "No key events",
    tip: "Real search traffic in this window but zero key events — visitors never take the next step (missing CTA or intent mismatch).",
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
  ai_only: {
    label: "AI-only",
    tip: "AI assistants (ChatGPT, Perplexity, etc.) send visitors here, but Google search sends zero clicks — worth checking how it appears in classic results.",
    className:
      "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
  },
};

const VERDICT_ORDER: PageReportRowVerdictsItem[] = [
  "low_ctr",
  "weak_engagement",
  "no_conversions",
  "ai_only",
];

function VerdictBadges({ verdicts }: { verdicts: PageReportRowVerdictsItem[] }) {
  if (verdicts.length === 0) return null;
  return (
    <span className="inline-flex gap-1 ml-2 align-middle">
      {verdicts.map((v) => {
        const m = VERDICT_META[v];
        return (
          <Tooltip key={v}>
            <TooltipTrigger asChild>
              <Badge variant="outline" className={`text-[10px] cursor-default ${m.className}`}>
                {m.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{m.tip}</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-display mt-1">{value}</div>
    </div>
  );
}

export default function PageReport() {
  const initial = presetRange("28d");
  const [preset, setPreset] = useState<Preset>("28d");
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<Channel>("organic");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "impressions", dir: "desc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const { data, isLoading, error } = useGetPagesReport({ startDate, endDate, channel });

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.rows.filter(
      (r) =>
        (search ? r.path.toLowerCase().includes(search.toLowerCase()) : true) &&
        (onlyFlagged ? r.verdicts.length > 0 : true),
    );
    return filtered.slice().sort((a, b) => {
      const av = a[sort.key] as string | number;
      const bv = b[sort.key] as string | number;
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data, search, sort, onlyFlagged]);

  const narrative = useMemo(() => {
    if (!data) return null;
    const counts: Record<PageReportRowVerdictsItem, number> = {
      low_ctr: 0,
      weak_engagement: 0,
      no_conversions: 0,
      ai_only: 0,
    };
    const example: Partial<Record<PageReportRowVerdictsItem, string>> = {};
    let withTraffic = 0;
    for (const r of data.rows) {
      if (r.impressions > 0) withTraffic += 1;
      for (const v of r.verdicts) {
        counts[v] += 1;
        // rows are impression-sorted server-side, so first hit = biggest example
        if (!example[v]) example[v] = r.path;
      }
    }
    return { counts, example, withTraffic, flaggedTotal: data.rows.filter((r) => r.verdicts.length > 0).length };
  }, [data]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setStartDate(r.startDate);
      setEndDate(r.endDate);
    }
  };

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-3xl font-display text-foreground">Page Report</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          One row per page combining Google Search Console (average position, impressions, clicks,
          and the queries it ranks for) with GA4 engagement — scoped to Organic Search by default,
          plus key events and AI-assistant referrals. Refreshes automatically — cached for 30
          minutes to protect API quota.
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
          <Label className="text-xs text-muted-foreground">GA4 traffic</Label>
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
        summary="A per-page scorecard that joins Search Console (how Google ranks the page) with GA4 (how visitors behave once they land). Expand any row to see the search queries that page ranks for."
        steps={[
          {
            title: "Pick a window",
            body: "GSC live data is limited to ~16 months and is freshest over the last 28 days; the 3- and 6-month presets pull from GA4 + GSC together.",
          },
          {
            title: "Read search next to engagement",
            body: "Position, impressions and clicks are from Search Console. Engagement rate and sessions are from GA4 landing pages — Organic Search only by default; use the toggle for all channels. AI sessions (ChatGPT, Claude, Perplexity, Gemini, Copilot referrals) are always counted across every channel.",
          },
          {
            title: "Expand for queries",
            body: "Click a row to reveal the top queries that page ranks for, each with its own position, impressions and clicks.",
          },
        ]}
        faqs={[
          {
            title: "Why do some pages show — for position or engagement?",
            body: "A dash means that page had no Search Console impressions (position) or no GA4 sessions (engagement) in the selected window. Every known page is listed so you can spot the gaps.",
          },
          {
            title: "What do the colored badges next to a page mean?",
            body: "They flag mismatches between ranking and behavior: Low CTR (ranks top-10 but loses the click), Weak engagement (ranks well but visitors leave fast), No key events (real traffic, zero conversions), and AI-only (AI assistants cite it but Google sends no clicks). Hover a badge for the full explanation, or press Needs attention to see only flagged pages.",
          },
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error || !data ? (
        <div className="py-12 text-center text-sm text-destructive">
          Failed to load report. {error instanceof Error ? error.message : ""}
        </div>
      ) : (
        <>
          {data.ga4Notice ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm px-4 py-2 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200">
              {data.ga4Notice}
            </div>
          ) : null}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Impressions" value={data.totals.impressions.toLocaleString()} />
            <StatCard label="Clicks" value={data.totals.clicks.toLocaleString()} />
            <StatCard label="Avg position" value={pos(data.totals.position, data.totals.impressions)} />
            <StatCard label="Sessions" value={data.totals.sessions.toLocaleString()} />
            <StatCard
              label="Engagement rate"
              value={rate(data.totals.engagementRate, data.totals.sessions)}
            />
          </div>

          {narrative ? (
            <DataNarrative
              paragraphs={[
                <>
                  Over this window, <Num>{narrative.withTraffic.toLocaleString()}</Num> pages
                  appeared in Google search, earning{" "}
                  <Num>{data.totals.impressions.toLocaleString()}</Num> impressions and{" "}
                  <Num>{data.totals.clicks.toLocaleString()}</Num> clicks.{" "}
                  {narrative.flaggedTotal > 0 ? (
                    <>
                      <Num>{narrative.flaggedTotal.toLocaleString()}</Num>{" "}
                      {narrative.flaggedTotal === 1 ? "page shows" : "pages show"} a mismatch
                      between how Google ranks them and what visitors do next — those are the
                      badges in the table below.
                    </>
                  ) : (
                    <>No ranking-vs-behavior mismatches were detected in this window.</>
                  )}
                </>,
              ]}
              insights={VERDICT_ORDER.filter((v) => narrative.counts[v] > 0).map((v) => ({
                tone: v === "ai_only" ? ("neutral" as const) : ("warn" as const),
                text: (
                  <>
                    <Num>{narrative.counts[v]}</Num>{" "}
                    {narrative.counts[v] === 1 ? "page" : "pages"}:{" "}
                    {VERDICT_META[v].tip.split(" — ")[0]}
                    {narrative.example[v] ? (
                      <>
                        {" "}
                        (biggest: <span className="font-mono text-xs">{narrative.example[v]}</span>)
                      </>
                    ) : null}
                  </>
                ),
              }))}
            />
          ) : null}

          <div className="flex gap-2 items-center">
            <InfoTip>Every known page — including those with no traffic in this window.</InfoTip>
            <Input
              placeholder="Filter path..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-md h-9"
            />
            <Button
              size="sm"
              variant={onlyFlagged ? "default" : "outline"}
              onClick={() => setOnlyFlagged((v) => !v)}
            >
              Needs attention{narrative && narrative.flaggedTotal > 0 ? ` (${narrative.flaggedTotal})` : ""}
            </Button>
            <div className="text-xs text-muted-foreground ml-auto">{rows.length} pages</div>
            <CopyButton
              disabled={rows.length === 0}
              getText={() =>
                rowsToTsv(
                  [
                    "Path",
                    "Avg Position",
                    "Impressions",
                    "Clicks",
                    "Engagement Rate",
                    "Sessions",
                    "Engaged Sessions",
                    "Avg Engagement Time",
                    "Key Events",
                    "AI Sessions",
                    "Query Count",
                    "Flags",
                    "Top Queries",
                  ],
                  rows.map((r) => [
                    r.path,
                    r.impressions > 0 ? r.position.toFixed(1) : "",
                    r.impressions,
                    r.clicks,
                    r.sessions > 0 ? `${(r.engagementRate * 100).toFixed(1)}%` : "",
                    r.sessions,
                    r.engagedSessions,
                    r.sessions > 0 ? fmtTime(r.avgEngagementTime, r.sessions) : "",
                    r.keyEvents,
                    r.aiSessions,
                    r.queryCount,
                    r.verdicts.map((v) => VERDICT_META[v].label).join(", "),
                    r.topQueries.map((q) => q.query).join(" | "),
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
                    <th className="w-8" />
                    <SortableHeader col="path" label="Path" sort={sort} onChange={setSort} align="left" />
                    <SortableHeader col="position" label="Avg Pos." sort={sort} onChange={setSort} />
                    <SortableHeader col="impressions" label="Impr." sort={sort} onChange={setSort} />
                    <SortableHeader col="clicks" label="Clicks" sort={sort} onChange={setSort} />
                    <SortableHeader col="engagementRate" label="Eng. Rate" sort={sort} onChange={setSort} />
                    <SortableHeader col="sessions" label="Sessions" sort={sort} onChange={setSort} />
                    <SortableHeader col="avgEngagementTime" label="Eng. Time" sort={sort} onChange={setSort} />
                    <SortableHeader col="keyEvents" label="Key Events" sort={sort} onChange={setSort} />
                    <SortableHeader col="aiSessions" label="AI Sess." sort={sort} onChange={setSort} />
                    <SortableHeader col="queryCount" label="Queries" sort={sort} onChange={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isOpen = expanded.has(r.path);
                    const canExpand = r.queryCount > 0;
                    return (
                      <Fragment key={r.path}>
                        <tr
                          className={`border-t hover:bg-muted/20 ${canExpand ? "cursor-pointer" : ""}`}
                          onClick={() => canExpand && toggle(r.path)}
                        >
                          <td className="pl-3 text-muted-foreground">
                            {canExpand ? (
                              isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )
                            ) : null}
                          </td>
                          <td className="p-3 max-w-md text-primary" title={r.title || r.path}>
                            <span className="inline-block max-w-[22rem] truncate align-middle">{r.path}</span>
                            <VerdictBadges verdicts={r.verdicts} />
                          </td>
                          <td className="p-3 text-right font-mono">{pos(r.position, r.impressions)}</td>
                          <td className="p-3 text-right font-mono">{r.impressions.toLocaleString()}</td>
                          <td className="p-3 text-right font-mono">{r.clicks.toLocaleString()}</td>
                          <td className="p-3 text-right font-mono">{rate(r.engagementRate, r.sessions)}</td>
                          <td className="p-3 text-right font-mono">{r.sessions.toLocaleString()}</td>
                          <td className="p-3 text-right font-mono">{fmtTime(r.avgEngagementTime, r.sessions)}</td>
                          <td className="p-3 text-right font-mono">{r.keyEvents.toLocaleString()}</td>
                          <td className="p-3 text-right font-mono">{r.aiSessions.toLocaleString()}</td>
                          <td className="p-3 text-right font-mono">{r.queryCount.toLocaleString()}</td>
                        </tr>
                        {isOpen && canExpand ? (
                          <tr className="bg-muted/10 border-t">
                            <td />
                            <td colSpan={10} className="p-3">
                              <div className="text-xs text-muted-foreground mb-2">
                                {r.sessions > 0 ? (
                                  <>
                                    Visitor engagement on this page: {r.sessions.toLocaleString()} sessions
                                    {" · "}
                                    {r.engagedSessions.toLocaleString()} engaged ({rate(r.engagementRate, r.sessions)})
                                    {" · "}
                                    {fmtTime(r.avgEngagementTime, r.sessions)} avg time
                                  </>
                                ) : (
                                  "No GA4 sessions recorded for this page in this window."
                                )}
                              </div>
                              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                Top queries{r.queryCount > r.topQueries.length ? ` (top ${r.topQueries.length} of ${r.queryCount})` : ""}
                              </div>
                              <table className="w-full text-sm">
                                <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                                  <tr>
                                    <th className="text-left font-medium pb-1">Query</th>
                                    <th className="text-right font-medium pb-1">Position</th>
                                    <th className="text-right font-medium pb-1">Impr.</th>
                                    <th className="text-right font-medium pb-1">Clicks</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.topQueries.map((q) => (
                                    <tr key={q.query} className="border-t border-border/50">
                                      <td className="py-1.5 pr-3 max-w-lg truncate">{q.query}</td>
                                      <td className="py-1.5 text-right font-mono">{q.position.toFixed(1)}</td>
                                      <td className="py-1.5 text-right font-mono">{q.impressions.toLocaleString()}</td>
                                      <td className="py-1.5 text-right font-mono">{q.clicks.toLocaleString()}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
