import { useState, useMemo } from "react";
import { Link as WouterLink } from "wouter";
import {
  useGetDashboardSummary,
  useGetJobStatus,
  useRunJob,
  useGetDashboardUrls,
  useGetHealthScore,
  useGetDailyActivity,
  useListActions,
  getGetDashboardSummaryQueryKey,
  getGetJobStatusQueryKey,
  getGetDashboardUrlsQueryKey,
  getGetHealthScoreQueryKey,
  getGetDailyActivityQueryKey,
  getListActionsQueryKey,
} from "@workspace/api-client-react";

type DashboardUrlType =
  | "pages"
  | "links"
  | "orphans"
  | "dead-ends"
  | "pending-suggestions"
  | "critical-losers";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Activity,
  LayoutTemplate,
  Link2,
  AlertTriangle,
  AlertCircle,
  FileWarning,
  Inbox,
  ExternalLink,
  Rocket,
  Loader2,
  ChevronRight,
  TrendingDown,
  ArrowUpRight,
  ArrowDownLeft,
  Settings2,
  CheckCircle2,
  ActivitySquare,
  Sparkles,
  SearchCheck,
  MousePointerClick,
  Split,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { LinkBreakdownDrawer } from "@/components/link-breakdown-drawer";
import { getJobLabel } from "@/lib/job-labels";
import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const RUNNABLE_JOB_NAMES = [
  "crawl_link_map",
  "gsc_inventory_and_losers",
  "semantic_linking",
  "optimize_queued_urls",
  "run_full_pipeline",
] as const;
type RunnableJobName = (typeof RUNNABLE_JOB_NAMES)[number];
function isRunnableJobName(name: string): name is RunnableJobName {
  return (RUNNABLE_JOB_NAMES as readonly string[]).includes(name);
}

const PIPELINE_JOB: RunnableJobName = "run_full_pipeline";

interface KpiSpec {
  title: string;
  value: number;
  icon: LucideIcon;
  color: string;
  tip: string;
  urlType: DashboardUrlType;
  fullPagePath?: string;
  fullPageLabel?: string;
}

function UrlListDialog({
  kpi,
  open,
  onOpenChange,
}: {
  kpi: KpiSpec | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const enabled = open && !!kpi;
  const { data, isLoading } = useGetDashboardUrls(
    kpi?.urlType ?? "pages",
    {
      query: {
        queryKey: kpi ? getGetDashboardUrlsQueryKey(kpi.urlType) : ["dashboard-urls-disabled"],
        enabled,
        staleTime: 30_000,
      },
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="url-list-dialog-title">
            {kpi && <kpi.icon className={`h-5 w-5 ${kpi.color}`} />}
            {kpi?.title}
          </DialogTitle>
          <DialogDescription>{kpi?.tip}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between text-xs text-muted-foreground border-b pb-2">
          <div data-testid="url-list-counts">
            {data
              ? `Showing ${data.returned.toLocaleString()} of ${data.total.toLocaleString()}`
              : "Loading…"}
            {data && data.returned < data.total && " (capped at 500 — visit the full page for the rest)"}
          </div>
          {kpi?.fullPagePath && (
            <WouterLink
              href={kpi.fullPagePath}
              onClick={() => onOpenChange(false)}
              className="text-primary hover:underline font-medium"
            >
              {kpi.fullPageLabel ?? "View full page →"}
            </WouterLink>
          )}
        </div>
        <div className="overflow-y-auto -mx-1 px-1 flex-1">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6" />
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12 italic" data-testid="url-list-empty">
              Nothing to show.
            </div>
          ) : (
            <div className="divide-y">
              {data.items.map((item, i) => (
                <div key={`${item.url}-${i}`} className="py-2 flex items-start gap-2" data-testid={`url-list-item-${i}`}>
                  <div className="min-w-0 flex-1">
                    {item.label && (
                      <div className="text-sm font-medium truncate" title={item.label}>
                        {item.label}
                      </div>
                    )}
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline font-mono break-all flex items-center gap-1"
                    >
                      <span className="truncate">{item.url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                    </a>
                    {item.sublabel && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 truncate" title={item.sublabel}>
                        {item.sublabel}
                      </div>
                    )}
                  </div>
                  {item.count != null && (
                    <div className="text-xs font-mono text-muted-foreground shrink-0 tabular-nums">
                      {item.count.toLocaleString()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function getHealthScoreColor(label: string) {
  switch (label) {
    case "excellent": return "text-emerald-500 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900";
    case "good": return "text-sky-500 bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-900";
    case "fair": return "text-amber-500 bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900";
    case "needs_work": return "text-orange-500 bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-900";
    case "critical": return "text-red-500 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900";
    default: return "text-primary bg-primary/5 border-primary/20";
  }
}

function getHealthScoreChartColor(label: string) {
  switch (label) {
    case "excellent": return "hsl(var(--chart-2))"; // Assuming emerald-ish
    case "good": return "hsl(var(--chart-3))";
    case "fair": return "hsl(var(--chart-4))";
    case "needs_work": return "hsl(var(--chart-5))";
    case "critical": return "hsl(var(--destructive))";
    default: return "hsl(var(--primary))";
  }
}

const ACTION_CONFIG: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  add_inbound_links: { label: "Add inbound", icon: ArrowDownLeft, color: "text-amber-500 bg-amber-50 dark:bg-amber-900/20" },
  add_outbound_links: { label: "Add outbound", icon: ArrowUpRight, color: "text-sky-500 bg-sky-50 dark:bg-sky-900/20" },
  fix_losing_query: { label: "Fix losing query", icon: TrendingDown, color: "text-red-500 bg-red-50 dark:bg-red-900/20" },
  review_suggestions: { label: "Review suggestions", icon: Inbox, color: "text-violet-500 bg-violet-50 dark:bg-violet-900/20" },
  optimize_content: { label: "Optimize content", icon: Settings2, color: "text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20" },
  improve_ctr: { label: "Improve CTR", icon: MousePointerClick, color: "text-cyan-500 bg-cyan-50 dark:bg-cyan-900/20" },
  fix_cannibalization: { label: "Fix cannibalization", icon: Split, color: "text-orange-500 bg-orange-50 dark:bg-orange-900/20" },
};

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const runJob = useRunJob();
  const [openKpi, setOpenKpi] = useState<KpiSpec | null>(null);

  const { data: summary, isLoading: isSummaryLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() }
  });
  const { data: liveJobs } = useGetJobStatus({
    query: { queryKey: getGetJobStatusQueryKey(), refetchInterval: 5000 }
  });
  const { data: health, isLoading: isHealthLoading } = useGetHealthScore({
    query: { queryKey: getGetHealthScoreQueryKey() }
  });
  const { data: activity, isLoading: isActivityLoading } = useGetDailyActivity(
    { days: 14 },
    { query: { queryKey: getGetDailyActivityQueryKey({ days: 14 }) } }
  );
  const { data: actionsData, isLoading: isActionsLoading } = useListActions(
    { status: "open" },
    { query: { queryKey: getListActionsQueryKey({ status: "open" }) } }
  );

  const isLoading = isSummaryLoading || isHealthLoading || isActivityLoading || isActionsLoading;

  const [selectedActivityUrl, setSelectedActivityUrl] = useState<string | null>(null);

  const activityCounts = useMemo(() => {
    let published = 0;
    let optimized = 0;
    for (const item of activity?.items ?? []) {
      if (item.kind === "published") published += 1;
      else optimized += 1;
    }
    return { published, optimized };
  }, [activity]);

  const groupedActivity = useMemo(() => {
    if (!activity?.items) return [];
    const groups = new Map<string, typeof activity.items>();
    activity.items.forEach((item) => {
      const d = new Date(item.timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(item);
    });
    return Array.from(groups.entries());
  }, [activity]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner className="h-8 w-8 text-primary" />
      </div>
    );
  }

  if (!summary || !health) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 text-center">
        <p className="text-sm text-muted-foreground">
          Couldn't load the dashboard data. The API may be restarting.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetHealthScoreQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDailyActivityQueryKey({ days: 14 }) });
            queryClient.invalidateQueries({ queryKey: getListActionsQueryKey({ status: "open" }) });
          }}
          data-testid="button-retry-dashboard"
        >
          Retry
        </Button>
      </div>
    );
  }

  const handleRunJob = (jobName: RunnableJobName) => {
    const friendly = getJobLabel(jobName).title;
    runJob.mutate(
      { jobName },
      {
        onSuccess: () => {
          toast({ title: `Started: ${friendly}` });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetJobStatusQueryKey() });
        },
        onError: () => {
          toast({ variant: "destructive", title: `Failed to start: ${friendly}` });
        },
      },
    );
  };

  const kpis: KpiSpec[] = [
    {
      title: "Total Pages",
      value: summary.totalPages,
      icon: LayoutTemplate,
      color: "text-primary",
      tip: summary.pageFilterLabel,
      urlType: "pages",
      fullPagePath: "/link-map",
      fullPageLabel: "Open Link Map →",
    },
    {
      title: "Total Links",
      value: summary.totalLinks,
      icon: Link2,
      color: "text-primary",
      tip: "Total internal links connecting your pages.",
      urlType: "links",
      fullPagePath: "/link-map",
      fullPageLabel: "Open Link Map →",
    },
    {
      title: "Orphan Pages",
      value: summary.orphanCount,
      icon: AlertCircle,
      color: "text-amber-500",
      tip: "Pages with zero inbound internal links.",
      urlType: "orphans",
    },
    {
      title: "Dead Ends",
      value: summary.deadEndCount,
      icon: FileWarning,
      color: "text-amber-500",
      tip: "Pages with zero outbound internal links.",
      urlType: "dead-ends",
    },
    {
      title: "Pending Suggestions",
      value: summary.pendingSuggestionsCount,
      icon: Inbox,
      color: "text-primary",
      tip: "AI-generated internal link ideas waiting for review.",
      urlType: "pending-suggestions",
      fullPagePath: "/suggestions",
      fullPageLabel: "Open Semantic Links →",
    },
    {
      title: "Critical Losers",
      value: summary.criticalLosersCount,
      icon: AlertTriangle,
      color: "text-red-500",
      tip: "Queries that dropped sharply in position or impressions.",
      urlType: "critical-losers",
      fullPagePath: "/losers",
      fullPageLabel: "Open Query Losers →",
    },
  ];

  const liveJobMap = new Map((liveJobs ?? []).map((j) => [j.name, j]));
  const pipelineLive = liveJobMap.get(PIPELINE_JOB);
  const pipelineHistory = summary.jobs.find((j) => j.name === PIPELINE_JOB);
  const pipelineRunning = pipelineLive?.running ?? false;
  const anyJobRunning = (liveJobs ?? []).some((j) => j.running);

  const topActions = actionsData?.items.slice(0, 3) || [];
  const chartColor = getHealthScoreChartColor(health.label);

  return (
    <div className="space-y-8 max-w-[1400px] mx-auto pb-12 animate-in fade-in duration-500 slide-in-from-bottom-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground tracking-tight flex items-center gap-2">
            Overview
          </h2>
          <p className="text-muted-foreground mt-1 text-sm font-medium">
            Morning briefing: site health, recent activity, and your next actions.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="px-3 py-1.5 flex items-center gap-2 text-xs font-mono rounded-md shadow-sm border-border/50">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Core: {summary.sectionCounts.core}
            <span className="text-muted-foreground opacity-50">/</span>
            Outer: {summary.sectionCounts.outer}
          </Badge>
        </div>
      </div>

      <HowThisWorks
        summary="A high-density view of the site's structural and semantic health. Check the score, review what changed, and knock out the top actions."
        steps={[
          { title: "Review the Health Score", body: "The 0-100 score aggregates broken links, orphans, dead ends, unreviewed suggestions, and losing queries. Keep it in the green." },
          { title: "Check Recent Activity", body: "The activity feed shows pages you've recently published or optimized, giving context to ranking changes." },
          { title: "Knock out Top Actions", body: "The 'Do This Next' list surfaces the 3 highest-leverage tasks based on traffic at stake. Click an action to jump right to the tool." },
        ]}
        className="mb-8 border-border shadow-sm bg-card/50 backdrop-blur-sm"
      />

      {/* Hero: Health Score Panel */}
      <Card className={cn("overflow-hidden border-2 shadow-md transition-colors duration-500", getHealthScoreColor(health.label))} data-testid="health-score-card">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] divide-y lg:divide-y-0 lg:divide-x border-inherit">
          
          <div className="p-6 md:p-8 flex flex-col justify-between">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-widest opacity-80 mb-1">Site Health</h3>
                <div className="flex items-baseline gap-3">
                  <span className="text-7xl font-display font-bold tracking-tighter leading-none" data-testid="health-score-value">
                    {health.score}
                  </span>
                  <span className="text-lg font-bold uppercase tracking-wider opacity-90" data-testid="health-score-label">
                    {health.label.replace('_', ' ')}
                  </span>
                </div>
              </div>
              <ActivitySquare className="w-10 h-10 opacity-20" />
            </div>

            <div className="mt-8 h-32 w-full -ml-2" data-testid="health-score-trend">
              {health.trend.length < 2 ? (
                <div className="h-full w-full flex items-center justify-center text-sm font-medium opacity-50 border border-dashed rounded-md border-inherit">
                  Collecting trend data...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={health.trend}>
                    <defs>
                      <linearGradient id="colorScore" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartColor} stopOpacity={0.3}/>
                        <stop offset="95%" stopColor={chartColor} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <Area 
                      type="monotone" 
                      dataKey="score" 
                      stroke={chartColor} 
                      strokeWidth={3}
                      fillOpacity={1} 
                      fill="url(#colorScore)" 
                      isAnimationActive={true} 
                    />
                    <YAxis domain={[0, 100]} hide />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="p-6 md:p-8 bg-background/50 backdrop-blur-sm">
            <h4 className="text-sm font-semibold mb-4 text-foreground flex items-center justify-between">
              Score Breakdown
              <span className="text-xs font-normal text-muted-foreground">Points Deducted</span>
            </h4>
            <div className="space-y-4">
              {health.components.map((comp) => (
                <div key={comp.key} className="group relative" data-testid={`health-comp-${comp.key}`}>
                  <div className="flex items-center justify-between mb-1 text-sm">
                    <span className="font-medium text-foreground cursor-help decoration-dashed decoration-border/50 underline underline-offset-4" title={comp.detail}>
                      {comp.label}
                    </span>
                    <span className="font-mono font-medium flex items-center gap-2">
                      {comp.raw > 0 ? (
                        <span className="text-muted-foreground text-xs">{comp.raw.toLocaleString()} issue{comp.raw > 1 ? 's' : ''}</span>
                      ) : null}
                      <span className={cn(comp.deduction > 0 ? "text-red-500 font-bold" : "text-muted-foreground")}>
                        {comp.deduction > 0 ? `-${Math.round(comp.deduction)}` : "0"}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                    <div 
                      className={cn("h-full rounded-full transition-all duration-1000", comp.deduction > 0 ? "bg-red-500" : "bg-emerald-500")}
                      style={{ width: `${Math.max(2, (comp.deduction / 100) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </Card>

      {/* Middle Grid: Activity & Next Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Activity Feed */}
        <Card className="flex flex-col border-border/60 shadow-sm h-[400px]">
          <CardHeader className="py-4 border-b bg-muted/20 flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              What Changed
              <InfoTip>
                Pages published and optimized in the last 14 days. Click any row to
                see that page's internal links and backlinks.
              </InfoTip>
            </CardTitle>
            {(activityCounts.published > 0 || activityCounts.optimized > 0) && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">
                  {activityCounts.published} published
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {activityCounts.optimized} optimized
                </Badge>
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              {groupedActivity.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground" data-testid="activity-feed-empty">
                  <div className="bg-muted p-3 rounded-full mb-3">
                    <SearchCheck className="h-5 w-5 opacity-50" />
                  </div>
                  <p className="text-sm">No recent activity found.</p>
                  <p className="text-xs opacity-70 mt-1">Published or optimized pages will appear here.</p>
                </div>
              ) : (
                <div className="p-4 space-y-6">
                  {groupedActivity.map(([date, items]) => (
                    <div key={date} className="space-y-3">
                      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur py-1 flex items-center gap-3">
                        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{date}</span>
                        <div className="h-px flex-1 bg-border/50" />
                      </div>
                      <div className="space-y-2">
                        {items.map((item, i) => (
                          <div
                            key={i}
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelectedActivityUrl(item.url)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedActivityUrl(item.url);
                              }
                            }}
                            className="flex gap-3 items-start group cursor-pointer rounded-md -mx-1 px-1 py-0.5 hover:bg-muted/40 transition-colors"
                          >
                            <div className="w-1.5 h-1.5 rounded-full bg-primary/40 mt-2 shrink-0 group-hover:bg-primary transition-colors" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate" title={item.title ?? item.url}>
                                {item.title ?? "Untitled Page"}
                              </p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono bg-muted text-muted-foreground">
                                  {item.kind}
                                </Badge>
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[11px] text-muted-foreground hover:text-primary transition-colors truncate block"
                                >
                                  {item.url.replace(/^https?:\/\/[^\/]+/, '')}
                                </a>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <LinkBreakdownDrawer
          url={selectedActivityUrl}
          onClose={() => setSelectedActivityUrl(null)}
        />

        {/* Next Actions */}
        <Card className="flex flex-col border-border/60 shadow-sm h-[400px]">
          <CardHeader className="py-4 border-b bg-muted/20 flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Do This Next
            </CardTitle>
            {actionsData && actionsData.counts.open > 3 && (
              <WouterLink href="/actions" className="text-xs font-medium text-primary hover:underline flex items-center">
                View all {actionsData.counts.open} <ChevronRight className="h-3 w-3 ml-0.5" />
              </WouterLink>
            )}
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              {topActions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full p-8 text-center" data-testid="actions-empty-state">
                  <div className="bg-emerald-500/10 p-4 rounded-full mb-4">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  </div>
                  <p className="text-base font-semibold text-foreground">All caught up!</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-[250px]">
                    Your action queue is completely clear. You've earned a break.
                  </p>
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {topActions.map((action) => {
                    const cfg = ACTION_CONFIG[action.actionType] ?? { label: action.actionType, icon: Settings2, color: "bg-muted text-muted-foreground" };
                    const Icon = cfg.icon;
                    return (
                      <div key={action.id} className="group relative border rounded-lg p-4 bg-card hover:border-primary/30 transition-colors shadow-sm" data-testid={`top-action-${action.id}`}>
                        <div className="flex gap-3">
                          <div className={cn("p-2 rounded-md shrink-0 h-min", cfg.color)}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                {cfg.label}
                              </span>
                              <span className="text-[10px] font-mono text-muted-foreground opacity-60">
                                Score {Math.round(action.score)}
                              </span>
                            </div>
                            <p className="text-sm font-semibold text-foreground leading-snug line-clamp-1 mb-1" title={action.title ?? action.targetUrl}>
                              {action.title ?? action.targetUrl.replace(/^https?:\/\/[^\/]+/, '')}
                            </p>
                            <p className="text-xs text-muted-foreground line-clamp-1">
                              {action.description}
                            </p>
                            <div className="mt-3 flex items-center justify-between">
                              <div className="text-[11px] font-mono text-muted-foreground">
                                <span className="font-bold text-foreground">{action.impressionsAtStake.toLocaleString()}</span> imp at stake
                              </div>
                              <WouterLink href="/actions" className="text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
                                Fix it <ArrowUpRight className="h-3 w-3 ml-0.5" />
                              </WouterLink>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {actionsData && actionsData.counts.open > 3 && (
                    <div className="pt-2 text-center">
                      <WouterLink href="/actions">
                        <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground hover:text-foreground">
                          See {actionsData.counts.open - 3} more actions in queue
                        </Button>
                      </WouterLink>
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {kpis.map((kpi, i) => (
          <Card
            key={kpi.urlType}
            className="border-border/50 shadow-sm transition-all hover:border-primary/40 hover:shadow-md cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpenKpi(kpi)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpenKpi(kpi);
              }
            }}
            data-testid={`kpi-card-${kpi.urlType}`}
            style={{ animationDelay: `${100 + i * 50}ms` }}
          >
            <CardContent className="p-4 flex flex-col justify-between h-full relative overflow-hidden">
              <div className="flex items-start justify-between mb-3">
                <kpi.icon className={cn("h-5 w-5", kpi.color)} />
                <InfoTip>{kpi.tip}</InfoTip>
              </div>
              <div>
                <div className="text-2xl font-bold font-display tracking-tight text-foreground">
                  {kpi.value.toLocaleString()}
                </div>
                <div className="text-xs font-medium text-muted-foreground truncate">
                  {kpi.title}
                </div>
              </div>
              <div className="absolute bottom-0 inset-x-0 h-1 bg-primary/10 translate-y-full group-hover:translate-y-0 transition-transform" />
            </CardContent>
          </Card>
        ))}
      </div>

      <UrlListDialog
        kpi={openKpi}
        open={openKpi !== null}
        onOpenChange={(o) => { if (!o) setOpenKpi(null); }}
      />

      {/* Background Jobs & Pipeline */}
      <div className="pt-6">
        <h3 className="text-xl font-headers font-semibold mb-4 flex items-center gap-2">
          System Engine
          <InfoTip>Scheduled background jobs that power the dashboard metrics and action queue.</InfoTip>
        </h3>
        
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-6">
          {/* Main Pipeline Runner */}
          <Card className="border-primary/30 bg-primary/[0.02] shadow-sm flex flex-col justify-between">
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2.5 rounded-lg">
                    <Rocket className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h4 className="font-headers text-lg font-bold">Run Full Pipeline</h4>
                    <p className="text-xs text-muted-foreground font-medium mt-0.5">End-to-end sync and analysis</p>
                  </div>
                </div>
                {pipelineRunning && <Spinner className="h-5 w-5 text-primary" />}
              </div>
              
              <div className="space-y-3 mb-6">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Sequentially runs: WP crawl → sitemap crawl → GSC sync → semantic linking → audits → content optimization.
                </p>
                {pipelineHistory && (
                  <div className="text-xs font-mono bg-background/50 p-2 rounded border border-border/50">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Last run:</span>
                      <span>{pipelineHistory.lastRunAt ? new Date(pipelineHistory.lastRunAt).toLocaleDateString() : "Never"}</span>
                    </div>
                    <div className="flex justify-between font-medium mt-1">
                      <span>Status:</span>
                      <span className={pipelineHistory.lastStatus === 'failed' ? 'text-red-500' : 'text-foreground'}>
                        {pipelineHistory.lastStatus || 'Unknown'} {pipelineHistory.lastDurationMs ? `(${Math.round(pipelineHistory.lastDurationMs / 1000)}s)` : ""}
                      </span>
                    </div>
                  </div>
                )}
                {pipelineHistory?.lastError && (
                  <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded-md border border-red-200 dark:border-red-900 mt-2 line-clamp-2">
                    {pipelineHistory.lastError}
                  </p>
                )}
              </div>

              <Button
                size="lg"
                className="w-full font-bold tracking-wide shadow-sm"
                onClick={() => handleRunJob(PIPELINE_JOB)}
                disabled={pipelineRunning || anyJobRunning || runJob.isPending}
                data-testid="btn-run-pipeline"
              >
                {pipelineRunning || anyJobRunning ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> System Busy</>
                ) : (
                  <><Rocket className="h-4 w-4 mr-2" /> Ignite Pipeline</>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Individual Jobs Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {summary.jobs.filter((j) => j.name !== PIPELINE_JOB).map((job) => {
              const live = liveJobMap.get(job.name);
              const isRunning = live?.running ?? false;
              const label = getJobLabel(job.name);
              return (
                <Card key={job.name} className="border-border/50 shadow-sm transition-colors hover:border-border group">
                  <CardContent className="p-4 flex flex-col h-full justify-between gap-4">
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="font-semibold text-sm text-foreground flex items-center gap-2">
                          {label.route ? (
                            <WouterLink href={label.route} className="hover:text-primary hover:underline underline-offset-2 truncate">
                              {label.title}
                            </WouterLink>
                          ) : (
                            <span className="truncate">{label.title}</span>
                          )}
                        </div>
                        {isRunning && <Spinner className="h-3 w-3 shrink-0 text-primary" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed mb-3">
                        {label.description}
                      </p>
                      
                      <div className="flex flex-col gap-1 text-[10px] font-mono text-muted-foreground bg-muted/30 p-1.5 rounded">
                        <div className="flex justify-between">
                          <span>Run:</span>
                          <span>{job.lastRunAt ? new Date(job.lastRunAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : "Never"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Status:</span>
                          <span className={job.lastStatus === 'failed' ? 'text-red-500 font-bold' : ''}>
                            {job.lastStatus || '--'} {job.lastDurationMs ? `(${Math.round(job.lastDurationMs / 1000)}s)` : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between mt-1">
                      {label.route ? (
                        <WouterLink href={label.route} className="text-[11px] font-medium text-primary hover:underline flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          View details <ArrowUpRight className="h-3 w-3" />
                        </WouterLink>
                      ) : <span />}
                      
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px] px-2.5 bg-muted/50 hover:bg-primary/10 hover:text-primary"
                        onClick={() => isRunnableJobName(job.name) && handleRunJob(job.name)}
                        disabled={isRunning || runJob.isPending || !isRunnableJobName(job.name)}
                        data-testid={`btn-run-job-${job.name}`}
                      >
                        <Activity className="h-3 w-3 mr-1.5" />
                        Run Now
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
