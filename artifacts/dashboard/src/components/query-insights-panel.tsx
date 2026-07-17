import { useEffect, useState } from "react";
import {
  useGetQueryInsights,
  getGetQueryInsightsQueryKey,
  type QueryInsights,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { InfoTip } from "@/components/info-tip";
import {
  TrendingDown,
  Sparkles,
  TrendingUp,
  BarChart3,
  Brain,
  CalendarClock,
} from "lucide-react";

function fmtPos(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toFixed(1);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${Number(n).toFixed(1)}%`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function deltaTone(n: number, lowerIsBetter = false): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return "text-muted-foreground";
  const good = lowerIsBetter ? n < 0 : n > 0;
  return good ? "text-green-600" : "text-red-500";
}

function pctChange(curr: number, prev: number): number {
  if (!prev) return curr ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

interface MetricCardProps {
  label: string;
  value: string;
  prevValue?: string | null;
  change?: number | null;
  lowerIsBetter?: boolean;
  hint?: string;
}

function MetricCard({ label, value, prevValue, change, lowerIsBetter, hint }: MetricCardProps) {
  return (
    <div className="rounded-md border border-border/60 bg-card p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {label}
        {hint && <InfoTip>{hint}</InfoTip>}
      </div>
      <div className="text-2xl font-display mt-1 text-foreground">{value}</div>
      {prevValue && (
        <div className="text-[11px] text-muted-foreground mt-0.5">prev {prevValue}</div>
      )}
      {change != null && Number.isFinite(change) && (
        <div className={`text-xs mt-1 font-mono ${deltaTone(change, lowerIsBetter)}`}>
          {change > 0 ? "+" : ""}
          {change.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

interface QueryInsightsPanelProps {
  filter: string;
}

/**
 * Self-contained query-level insight card. Given a query string it pulls a
 * 28-day GSC rollup plus AI strategy via useGetQueryInsights and renders it.
 * Reused by the Query Losers page drawer. Returns null when filter is empty.
 */
export function QueryInsightsPanel({ filter }: QueryInsightsPanelProps) {
  const trimmed = filter.trim();
  const debounced = useDebounced(trimmed, 600);
  const enabled = debounced.length >= 2 && debounced.length <= 200;
  const { data, isLoading, isFetching, error } = useGetQueryInsights(
    { q: enabled ? debounced : "_" },
    {
      query: {
        enabled,
        staleTime: 5 * 60 * 1000,
        queryKey: getGetQueryInsightsQueryKey({ q: enabled ? debounced : "_" }),
      },
    },
  );

  if (!trimmed) return null;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          Query performance & strategy for "{debounced || trimmed}"
          {trimmed !== debounced && (
            <span className="text-xs font-normal text-muted-foreground">(typing…)</span>
          )}
          <InfoTip>
            A 28-day Search Console rollup for this query plus AI-generated
            SEO/AEO/GEO recommendations. Cached for an hour per query.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <p className="text-sm text-muted-foreground">
            Type at least 2 characters to see a strategic summary for this query.
          </p>
        ) : (isLoading || isFetching) && !data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Fetching GSC stats and generating insights…
          </div>
        ) : error ? (
          <div className="text-sm text-amber-600">
            Couldn't load query insights. Search Console may not have data for "{debounced}" yet, or the GSC integration is unavailable.
          </div>
        ) : data ? (
          <QueryInsightsContent data={data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function QueryInsightsContent({ data }: { data: QueryInsights }) {
  const { totals, previousTotals, topPages, recentLosers, insight, windowStart, windowEnd } = data;
  const hasData = totals.impressions > 0 || topPages.length > 0;

  if (!hasData) {
    return (
      <div className="text-sm text-muted-foreground">
        Search Console has no impressions for queries containing "{data.query}" in
        the last 28 days. Either the keyword has zero reach yet, or it doesn't
        appear in GSC at this spelling. Try a broader or shorter variant.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock className="h-3 w-3" />
        Window: {windowStart} → {windowEnd} (28 days), compared to the prior 28 days. Data via Google Search Console.
      </div>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="Clicks"
          value={fmtNum(totals.clicks)}
          prevValue={previousTotals ? fmtNum(previousTotals.clicks) : null}
          change={previousTotals ? pctChange(totals.clicks, previousTotals.clicks) : null}
          hint="Total clicks across every page ranking for this query."
        />
        <MetricCard
          label="Impressions"
          value={fmtNum(totals.impressions)}
          prevValue={previousTotals ? fmtNum(previousTotals.impressions) : null}
          change={previousTotals ? pctChange(totals.impressions, previousTotals.impressions) : null}
          hint="How often any of your pages appeared in search results for this query."
        />
        <MetricCard
          label="CTR"
          value={`${(totals.ctr * 100).toFixed(2)}%`}
          prevValue={previousTotals ? `${(previousTotals.ctr * 100).toFixed(2)}%` : null}
          change={previousTotals ? pctChange(totals.ctr, previousTotals.ctr) : null}
          hint="Click-through-rate. CTR change usually signals title/meta or SERP-feature movement."
        />
        <MetricCard
          label="Avg position"
          value={totals.position.toFixed(1)}
          prevValue={previousTotals ? previousTotals.position.toFixed(1) : null}
          change={previousTotals ? pctChange(totals.position, previousTotals.position) : null}
          lowerIsBetter
          hint="Lower is better. Impression-weighted average rank across all ranking pages."
        />
      </div>

      {/* Top pages attracting the query */}
      <div>
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          Pages attracting this query
          <InfoTip>
            The pages on your site that Google is currently ranking for this query, ordered by impressions. The top page is your de-facto answer page — your strategy should make sure it stays that way (or move it to a better one).
          </InfoTip>
        </div>
        {topPages.length === 0 ? (
          <div className="text-sm text-muted-foreground">No pages found.</div>
        ) : (
          <div className="rounded-md border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">URL</th>
                  <th className="text-right px-3 py-2">Clicks</th>
                  <th className="text-right px-3 py-2">Impr</th>
                  <th className="text-right px-3 py-2">CTR</th>
                  <th className="text-right px-3 py-2">Pos</th>
                </tr>
              </thead>
              <tbody>
                {topPages.map((p) => (
                  <tr key={p.url} className="border-t border-border/60">
                    <td className="px-3 py-2 max-w-0">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline font-mono text-xs truncate block"
                        title={`Open ${p.url} in a new tab`}
                      >
                        {p.url}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmtNum(p.clicks)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtNum(p.impressions)}</td>
                    <td className="px-3 py-2 text-right font-mono">{(p.ctr * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right font-mono">{p.position.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent losers on this query */}
      {recentLosers.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-sm font-medium mb-2">
            <TrendingDown className="h-4 w-4 text-red-500" />
            Recent losers matching this query ({recentLosers.length})
          </div>
          <div className="space-y-1.5">
            {recentLosers.map((l) => (
              <div key={l.id} className="flex items-center gap-2 text-xs rounded border border-border/60 px-2.5 py-1.5">
                <Badge variant="outline" className={`capitalize shrink-0 ${l.severity === "critical" ? "text-red-600 border-red-300" : l.severity === "high" ? "text-amber-600 border-amber-300" : ""}`}>
                  {l.severity}
                </Badge>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline truncate flex-1" title={l.url}>
                  {l.url}
                </a>
                <span className="font-mono text-muted-foreground whitespace-nowrap">
                  pos {fmtPos(l.prevPosition)} → {fmtPos(l.currPosition)}
                </span>
                <span className={`font-mono whitespace-nowrap ${(l.impressionsChangePct ?? 0) < 0 ? "text-red-500" : "text-green-600"}`}>
                  {fmtPct(l.impressionsChangePct)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI strategic insights */}
      {insight ? (
        <div className="rounded-md border border-primary/30 bg-card p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            Strategic diagnosis & action plan
            <Badge variant="outline" className="text-[10px]">AI</Badge>
          </div>
          {insight.diagnosis && (
            <p className="text-sm text-foreground leading-relaxed">{insight.diagnosis}</p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {insight.strategy.length > 0 && (
              <InsightList
                icon={<TrendingUp className="h-4 w-4 text-blue-600" />}
                title="Traditional SEO actions"
                items={insight.strategy}
              />
            )}
            {insight.aeoGeo.length > 0 && (
              <InsightList
                icon={<Brain className="h-4 w-4 text-purple-600" />}
                title="AEO / GEO actions"
                hint="Answer Engine Optimization (Google AI Overviews, AI Mode) and Generative Engine Optimization (ChatGPT, Perplexity, Gemini, Claude citations)."
                items={insight.aeoGeo}
              />
            )}
          </div>
          {insight.sevenDayActions.length > 0 && (
            <InsightList
              icon={<CalendarClock className="h-4 w-4 text-amber-600" />}
              title="Ship this week"
              items={insight.sevenDayActions}
            />
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">
          AI strategic summary unavailable for this query.
        </div>
      )}
    </div>
  );
}

function InsightList({ icon, title, items, hint }: { icon: React.ReactNode; title: string; items: string[]; hint?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        {icon}
        {title}
        {hint && <InfoTip>{hint}</InfoTip>}
      </div>
      <ul className="space-y-1 text-sm">
        {items.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span className="text-foreground leading-snug">{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
