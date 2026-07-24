import { useState } from "react";
import { Link } from "wouter";
import {
  useGetSeoInsights,
  type SeoInsight,
  type SeoInsightId,
  type SeoInsightSeverity,
  type SeoInsightPage,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HowThisWorks } from "@/components/how-this-works";
import { DataNarrative, Num, type NarrativeInsight } from "@/components/data-narrative";
import {
  ChevronDown,
  AlertTriangle,
  TrendingUp,
  Eye,
  ArrowRight,
  Lightbulb,
  Wrench,
} from "lucide-react";

function fmt(v: number): string {
  return v.toLocaleString();
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleDateString();
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-display mt-1">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{hint}</div>
    </div>
  );
}

const SEVERITY_META: Record<
  SeoInsightSeverity,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  issue: {
    label: "Fix this",
    className:
      "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
    icon: AlertTriangle,
  },
  opportunity: {
    label: "Opportunity",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    icon: TrendingUp,
  },
  watch: {
    label: "Keep an eye on",
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    icon: Eye,
  },
};

/** Where "see all" should send the user for each insight type. */
const DEEP_LINK: Record<SeoInsightId, { href: string; label: string }> = {
  low_ctr: { href: "/report", label: "Open the Page Report" },
  bing_blind_spot: { href: "/bing", label: "Open Bing & AI Citations" },
  ai_visibility_gap: { href: "/bing", label: "Open Bing & AI Citations" },
  bing_upside: { href: "/bing", label: "Open Bing & AI Citations" },
  declining_queries: { href: "/losers", label: "Open Declining Queries" },
};

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap">
      <span className="font-medium text-foreground">{value}</span> {label}
    </span>
  );
}

function InsightPageRow({ page }: { page: SeoInsightPage }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 border-b last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium truncate" title={page.title ?? page.path}>
          {page.path}
        </span>
      </div>
      {page.detail ? (
        <div className="text-xs text-muted-foreground">{page.detail}</div>
      ) : null}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <MetricChip label="Google clicks" value={fmt(page.gscClicks)} />
        <MetricChip label="Bing clicks" value={fmt(page.bingClicks)} />
        {page.aiCitations > 0 ? <MetricChip label="AI citations" value={fmt(page.aiCitations)} /> : null}
        {page.aiSessions > 0 ? <MetricChip label="AI visits" value={fmt(page.aiSessions)} /> : null}
        {page.keyEvents > 0 ? <MetricChip label="key events" value={fmt(page.keyEvents)} /> : null}
      </div>
    </div>
  );
}

function InsightCard({ insight }: { insight: SeoInsight }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY_META[insight.severity];
  const link = DEEP_LINK[insight.id];
  const Icon = meta.icon;
  return (
    <Card data-testid={`card-insight-${insight.id}`}>
      <CardContent className="p-0">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="w-full flex items-start justify-between gap-3 p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
                  <Icon className="h-3 w-3 mr-1" />
                  {meta.label}
                </Badge>
                <span className="text-sm font-medium">{insight.title}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {fmt(insight.affectedCount)} page{insight.affectedCount === 1 ? "" : "s"}
                </span>
              </div>
              {!open ? (
                <p className="text-xs text-muted-foreground line-clamp-2">{insight.plainEnglish}</p>
              ) : null}
            </div>
            <ChevronDown
              className={`h-4 w-4 mt-1 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4 space-y-3">
              <p className="text-sm text-muted-foreground leading-relaxed">{insight.plainEnglish}</p>
              <div className="rounded-md border border-primary/20 bg-primary/[0.04] p-3 flex gap-2.5">
                <Wrench className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-medium">What to do: </span>
                  <span className="text-muted-foreground">{insight.action}</span>
                </div>
              </div>
              {insight.topPages.length > 0 ? (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Biggest wins first
                  </div>
                  <div className="rounded-md border px-3">
                    {insight.topPages.map((p) => (
                      <InsightPageRow key={p.path} page={p} />
                    ))}
                  </div>
                </div>
              ) : null}
              <Link href={link.href}>
                <Button variant="outline" size="sm" className="gap-1.5" data-testid={`link-insight-${insight.id}`}>
                  {link.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

export default function InsightsPage() {
  const { data, isLoading, error } = useGetSeoInsights();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="max-w-3xl">
        <h1 className="font-display text-2xl mb-2">SEO Insights</h1>
        <p className="text-sm text-muted-foreground">
          The insights report could not be loaded right now. Try again in a minute.
        </p>
      </div>
    );
  }

  const { kpis, insights, freshness } = data;
  const issueCount = insights.filter((i) => i.severity === "issue").length;
  const oppCount = insights.filter((i) => i.severity === "opportunity").length;

  const paragraphs: React.ReactNode[] = [
    <>
      Across every channel we track, <Num>{fmt(kpis.pages)} pages</Num> of your site have visibility
      somewhere: they earned <Num>{fmt(kpis.gscClicks)} Google clicks</Num> (latest Google window),{" "}
      <Num>{fmt(kpis.bingClicks)} Bing clicks</Num> (about 6 months), were quoted{" "}
      <Num>{fmt(kpis.aiCitations)} times</Num> by AI answers, and AI assistants sent{" "}
      <Num>{fmt(kpis.aiSessions)} visits</Num> in the last 28 days.
    </>,
    insights.length > 0 ? (
      <>
        Looking across all four data sources together, we found{" "}
        <Num>
          {insights.length} thing{insights.length === 1 ? "" : "s"} worth acting on
        </Num>
        {kpis.missedClicks > 0 ? (
          <>
            {" "}
            — including roughly <Num>{fmt(kpis.missedClicks)} Google clicks</Num> your rankings
            already earn but your titles are not converting
          </>
        ) : null}
        . Each card below explains the finding in plain English and what to do about it.
      </>
    ) : (
      <>
        Nothing needs your attention right now — no cross-channel gaps, click leaks, or ranking drops
        were detected in the latest synced data.
      </>
    ),
  ];

  const narrativeInsights: NarrativeInsight[] = [];
  if (issueCount > 0) {
    narrativeInsights.push({
      tone: "warn",
      text: (
        <>
          <Num>{issueCount}</Num> finding{issueCount === 1 ? "" : "s"} marked{" "}
          <Num>Fix this</Num> — start there.
        </>
      ),
    });
  }
  if (oppCount > 0) {
    narrativeInsights.push({
      tone: "good",
      text: (
        <>
          <Num>{oppCount}</Num> {oppCount === 1 ? "is an" : "are"} untapped{" "}
          {oppCount === 1 ? "opportunity" : "opportunities"} — extra traffic available without new
          content.
        </>
      ),
    });
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="font-display text-2xl">SEO Insights</h1>
        <p className="text-sm text-muted-foreground mt-1">
          One place where Google Search, Bing, visitor analytics, and AI citations are read together —
          and turned into specific next steps.
        </p>
      </div>

      <HowThisWorks
        summary="We combine four data sources and flag mismatches between them."
        steps={[
          {
            title: "Four sources, one view",
            body: "Google Search Console (how Google shows you), Bing Webmaster (how Bing shows you), GA4 (what visitors do), and AI-citation uploads (how often AI answers quote you) are read side by side.",
          },
          {
            title: "We look for mismatches",
            body: "The interesting findings live between sources: ranking well but not getting clicked, big on Google but missing on Bing, quoted by AI while classic search sends nothing, keywords slipping week over week.",
          },
          {
            title: "Every finding comes with a next step",
            body: "Each card says what we found, why it matters, and the one action that fixes or captures it — no jargon, no raw data dumps.",
          },
        ]}
        faqs={[
          {
            title: "Why can't I compare Google and Bing numbers directly?",
            body: "They cover different time windows: Google numbers come from the latest Search Console sync, Bing covers roughly the last 6 months, GA4 the last 28 days, and AI citations the most recent upload. We compare visibility patterns, never raw totals.",
          },
          {
            title: "Does this page cost anything to load?",
            body: "No. It reads only data that has already been synced — it never triggers crawls, API calls, or AI usage.",
          },
        ]}
      />

      <DataNarrative paragraphs={paragraphs} insights={narrativeInsights} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Pages with visibility" value={fmt(kpis.pages)} hint="seen by at least one source" />
        <KpiCard label="Google clicks" value={fmt(kpis.gscClicks)} hint={`latest sync · ${fmt(kpis.gscImpressions)} impressions`} />
        <KpiCard
          label="Bing clicks"
          value={freshness.bingSyncedAt ? fmt(kpis.bingClicks) : "—"}
          hint={
            freshness.bingSyncedAt
              ? `~6 months · ${fmt(kpis.bingImpressions)} impressions`
              : "Bing not synced yet — connect it in Settings"
          }
        />
        <KpiCard
          label="AI citations"
          value={freshness.aiCitationsAt ? fmt(kpis.aiCitations) : "—"}
          hint={
            freshness.aiCitationsAt
              ? `latest upload · ${fmt(kpis.aiSessions)} AI visits (28d)`
              : "No AI-citation upload yet — add one on the Bing & AI page"
          }
        />
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-lg">What the data is telling you</h2>
        {insights.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center space-y-2">
              <Lightbulb className="h-6 w-6 mx-auto text-muted-foreground" />
              <p className="text-sm font-medium">All clear</p>
              <p className="text-sm text-muted-foreground">
                No cross-channel issues or missed opportunities detected in the latest synced data.
                Check back after the next weekly sync.
              </p>
            </CardContent>
          </Card>
        ) : (
          insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Data freshness — Google Search: {fmtDate(freshness.gscSyncedAt)} · Visitor analytics (GA4):{" "}
        {fmtDate(freshness.ga4SyncedAt)} · Bing: {fmtDate(freshness.bingSyncedAt)} · AI citations:{" "}
        {fmtDate(freshness.aiCitationsAt)}. Each source covers its own time window, so totals are not
        directly comparable across columns.
      </p>
    </div>
  );
}
