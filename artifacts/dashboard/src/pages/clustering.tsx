import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useListClusterRuns,
  getListClusterRunsQueryKey,
  useStartClusterRun,
  useRebuildClusterRun,
  useListClusterRunClusters,
  getListClusterRunClustersQueryKey,
  type ClusterRun,
  type KeywordCluster,
  type ClusterKeyword,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { COUNTRY_OPTIONS } from "@/components/perf-blocks";
import { HowThisWorks } from "@/components/how-this-works";
import { JobSpendCapNotice } from "@/components/spend-cap-badge";
import { InfoTip } from "@/components/info-tip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  Play,
  Sparkles,
} from "lucide-react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { getUtcWindows, formatWindowDate } from "@/lib/date-helpers";

const SERP_LOCATIONS = [
  { value: "2840", label: "United States" },
  { value: "2826", label: "United Kingdom" },
  { value: "2356", label: "India" },
  { value: "2124", label: "Canada" },
  { value: "2036", label: "Australia" },
  { value: "2276", label: "Germany" },
  { value: "2250", label: "France" },
  { value: "2528", label: "Netherlands" },
  { value: "2702", label: "Singapore" },
];

const QUADRANT_META: Record<
  string,
  { label: string; desc: string; color: string; badge: string }
> = {
  opportunities: {
    label: "Opportunities",
    desc: "High impressions, low CTR — fix titles/snippets or build better pages",
    color: "#f59e0b",
    badge: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  },
  stars: {
    label: "Stars",
    desc: "High impressions, high CTR — protect these",
    color: "#10b981",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800",
  },
  niche: {
    label: "Niche Performers",
    desc: "Low impressions, high CTR — expand coverage",
    color: "#3b82f6",
    badge: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  },
  underperformers: {
    label: "Underperformers",
    desc: "Low impressions, low CTR",
    color: "#94a3b8",
    badge: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  },
};

const PHASE_LABELS: Record<string, string> = {
  fetching_queries: "Pulling top queries from Search Console…",
  posting_serp_tasks: "Sending keywords to DataForSEO…",
  fetching_serps: "Scraping live Google results…",
  clustering: "Building intent clusters…",
  labeling: "Naming clusters with AI…",
  saving: "Saving results…",
  done: "Done",
};

const stateLabels = {
  new: "New",
  rising: "Rising",
  displaced: "Displaced",
  zero_click: "Zero Click",
  striking_distance: "Striking Dist.",
  stable: "Stable"
};

const stateColors = {
  new: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-400",
  rising: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400",
  displaced: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-400",
  zero_click: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400",
  striking_distance: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400",
  stable: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
};

const stateMeanings = {
  rising: "Current impressions >30% vs prior.",
  displaced: "Clicks down >30% while impressions within +/-10%.",
  zero_click: "Current impressions >=10 AND current CTR <0.5%.",
  striking_distance: "Current impressions >=10 AND current avg position 5-15.",
  stable: "No other movement rule matched.",
  new: "Prior impressions zero (overrides other matching states)."
};

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function formatRatioNode(ratio: number | null | undefined, isNew: boolean) {
  if (ratio == null) {
    if (isNew) {
       return <span className="text-purple-600 dark:text-purple-400 font-semibold">New</span>;
    }
    return null;
  }
  const pct = ratio * 100;
  const isPos = pct > 0;
  const isNeg = pct < 0;
  const color = isPos ? "text-emerald-600 dark:text-emerald-400" : isNeg ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground";
  return (
    <span className={`font-semibold ${color}`}>
      {isPos ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

interface ChartDatum {
  x: number;
  y: number;
  z: number;
  topic: string;
  clicks: number;
  quadrant: string;
}

function runLabel(r: ClusterRun): string {
  const date = new Date(r.createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const kws = r.stats?.["keywords"];
  const runParams = r.params as { weeks?: number | null; days?: number | null; keywordLimit?: number | null };
  const duration = runParams.weeks ? `${runParams.weeks}w` : `${runParams.days}d`;
  return `${date} — ${duration}, ${kws ? `${fmtInt(kws)} keywords` : `up to ${runParams.keywordLimit} keywords`}`;
}

export function ExpandedClusterDetail({ cluster }: { cluster: KeywordCluster }) {
  const [kwStateFilter, setKwStateFilter] = useState<string>("all");

  const kws = cluster.keywords ?? [];
  const displayedKws = kwStateFilter === "all" ? kws : kws.filter(kw => kw.state === kwStateFilter);

  const ownUrls = cluster.ownUrls ?? [];
  const compUrls = cluster.competitorUrls ?? [];

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
        <h4 className="font-semibold text-sm text-foreground">Keywords in {cluster.topic}</h4>
        <Select value={kwStateFilter} onValueChange={setKwStateFilter}>
          <SelectTrigger className="w-[180px] h-8 text-xs bg-background" data-testid={`select-state-filter-${cluster.clusterKey}`}>
             <SelectValue placeholder="Filter by movement" />
          </SelectTrigger>
          <SelectContent>
             <SelectItem value="all">All movements</SelectItem>
             {Object.entries(stateLabels).map(([val, label]) => (
               <SelectItem key={val} value={val}>{label}</SelectItem>
             ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border border-border overflow-hidden bg-background shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-1/3">Query</TableHead>
              <TableHead>Movement</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Impr.</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">Pos.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedKws.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-6">No keywords match this filter.</TableCell></TableRow>
            ) : displayedKws.map((kw, i) => (
              <TableRow key={i} className="hover:bg-muted/10 transition-colors">
                <TableCell className="align-top">
                  <div className="whitespace-normal break-words max-w-[300px] sm:max-w-md font-medium text-foreground text-sm">
                    {kw.query}
                  </div>
                  {kw.serpUrls && kw.serpUrls.length > 0 && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {kw.serpUrls.slice(0, 3).map((su) => (
                        <a key={su.url} href={su.url} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 w-fit">
                          <span className="opacity-50">#{su.position}</span>
                          <span className="truncate max-w-[250px]">{su.url}</span>
                        </a>
                      ))}
                      {kw.serpUrls.length > 3 && (
                        <span className="text-[10px] text-muted-foreground opacity-70">+{kw.serpUrls.length - 3} more</span>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  {kw.state ? (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border-transparent ${stateColors[kw.state as keyof typeof stateColors] ?? stateColors.stable}`}>
                        {stateLabels[kw.state as keyof typeof stateLabels] ?? kw.state}
                      </Badge>
                      <InfoTip>{stateMeanings[kw.state as keyof typeof stateMeanings] ?? kw.state}</InfoTip>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right align-top">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-medium text-foreground text-sm">{fmtInt(kw.clicks)}</span>
                    {kw.priorClicks != null ? (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        {formatRatioNode(kw.clickDelta, kw.priorClicks === 0 && kw.clicks > 0)}
                        {kw.clickDeltaAbs != null && kw.clickDeltaAbs !== 0 && (
                          <span className="ml-1 opacity-70" title="Absolute change">({kw.clickDeltaAbs > 0 ? "+" : ""}{fmtInt(kw.clickDeltaAbs)})</span>
                        )}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right align-top">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-medium text-foreground text-sm">{fmtInt(kw.impressions)}</span>
                    {kw.priorImpressions != null ? (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        {formatRatioNode(kw.impressionDelta, kw.priorImpressions === 0 && kw.impressions > 0)}
                        {kw.impressionDeltaAbs != null && kw.impressionDeltaAbs !== 0 && (
                          <span className="ml-1 opacity-70" title="Absolute change">({kw.impressionDeltaAbs > 0 ? "+" : ""}{fmtInt(kw.impressionDeltaAbs)})</span>
                        )}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right align-top">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-medium text-foreground text-sm">{(kw.ctr * 100).toFixed(1)}%</span>
                    {kw.priorCtr != null ? (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        prev {(kw.priorCtr * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right align-top">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-medium text-foreground text-sm">{kw.position.toFixed(1)}</span>
                    {kw.priorPosition != null ? (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        prev {kw.priorPosition.toFixed(1)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 mt-4 pt-4 border-t border-border/50">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Your ranking URLs
          </div>
          {ownUrls.length === 0 ? (
            <p className="text-sm text-muted-foreground">None found in the top results.</p>
          ) : (
            <ul className="space-y-1.5">
              {ownUrls.map((u) => (
                <li key={u.url}>
                  <a href={u.url} target="_blank" rel="noreferrer" className="group flex items-start gap-1.5 text-sm text-foreground hover:text-primary transition-colors">
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
                    <span className="break-all">{u.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Competitors ranking in results
          </div>
          {compUrls.length === 0 ? (
            <p className="text-sm text-muted-foreground">None recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {compUrls.map((u) => (
                <li key={u.url}>
                  <a href={u.url} target="_blank" rel="noreferrer" className="group flex items-start gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors">
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
                    <span className="break-all line-clamp-2">{u.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Clustering() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ---- runs list (polls while a run is active) ----
  const runsQ = useListClusterRuns({
    query: {
      queryKey: getListClusterRunsQueryKey(),
      refetchInterval: (query) => {
        const rows = query.state.data ?? [];
        return rows.some((r) => r.status === "queued" || r.status === "running")
          ? 4000
          : false;
      },
    },
  });
  const runs = runsQ.data ?? [];
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "running");
  const completeRuns = runs.filter((r) => r.status === "complete");

  const prevActiveIdRef = useRef<number | null>(null);
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    if (prevId != null && !activeRun) {
      queryClient.invalidateQueries({
        queryKey: getListClusterRunClustersQueryKey(prevId),
      });
    }
    prevActiveIdRef.current = activeRun?.id ?? null;
  }, [activeRun, queryClient]);
  const failedLatest =
    !activeRun && runs.length > 0 && runs[0]!.status !== "complete" ? runs[0] : null;

  // ---- run selection ----
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const selectedRun =
    completeRuns.find((r) => r.id === selectedRunId) ?? completeRuns[0] ?? null;

  const clustersQ = useListClusterRunClusters(selectedRun?.id ?? 0, {
    query: {
      queryKey: getListClusterRunClustersQueryKey(selectedRun?.id ?? 0),
      enabled: selectedRun != null,
      staleTime: 10 * 60 * 1000,
    },
  });
  const allClusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);

  // ---- form state ----
  const [weeks, setWeeks] = useState(12);
  const [country, setCountry] = useState("all");
  const [keywordLimit, setKeywordLimit] = useState("250");
  const [locationCode, setLocationCode] = useState("2840");
  const [excludeBrand, setExcludeBrand] = useState(true);
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);

  const previewWindows = useMemo(() => getUtcWindows(weeks), [weeks]);

  const startMutation = useStartClusterRun();
  const keywordCount = Math.max(10, Math.min(1000, Number(keywordLimit) || 250));
  const estCost = (keywordCount * 0.0006).toFixed(2);
  const handleStart = () => {
    const limit = Math.max(10, Math.min(1000, Number(keywordLimit) || 250));
    startMutation.mutate(
      {
        data: {
          weeks,
          ...(country !== "all" ? { country } : {}),
          keywordLimit: limit,
          locationCode: Number(locationCode),
          excludeBrand,
          paidRunConfirmed: true,
        },
      },
      {
        onSuccess: () => {
          setConfirmRunOpen(false);
          toast({
            title: "Clustering run started",
            description:
              "Scraping live Google results usually takes 2–5 minutes. This page updates automatically.",
          });
          queryClient.invalidateQueries({ queryKey: getListClusterRunsQueryKey() });
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : "Failed to start the clustering run";
          toast({ variant: "destructive", title: "Couldn't start run", description: msg });
        },
      },
    );
  };

  const rebuildMutation = useRebuildClusterRun();
  const handleRebuild = (runId: number) => {
    rebuildMutation.mutate(
      { runId },
      {
        onSuccess: () => {
          toast({
            title: "Rebuilding clusters",
            description:
              "Re-grouping and renaming from the already-scraped Google results — no new scraping cost. Takes under a minute.",
          });
          queryClient.invalidateQueries({ queryKey: getListClusterRunsQueryKey() });
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : "Failed to start the rebuild";
          toast({ variant: "destructive", title: "Couldn't rebuild", description: msg });
        },
      },
    );
  };

  // ---- chart data ----
  const [showOutliers, setShowOutliers] = useState(false);
  const [quadrantFilter, setQuadrantFilter] = useState<string | null>(null);

  const realClusters = useMemo(
    () => allClusters.filter((c) => c.clusterKey !== -1),
    [allClusters],
  );
  const unclusteredRow = allClusters.find((c) => c.clusterKey === -1) ?? null;

  const filteredForMedians = realClusters.filter((c) => !c.isOutlier);
  const medImp = median(filteredForMedians.map((c) => c.totalImpressions));
  const medCtr = median(filteredForMedians.map((c) => c.blendedCtr));

  const chartClusters = showOutliers
    ? realClusters
    : realClusters.filter((c) => !c.isOutlier);
  const chartByQuadrant = useMemo(() => {
    const groups: Record<string, ChartDatum[]> = {};
    for (const c of chartClusters) {
      const q = c.quadrant ?? "underperformers";
      (groups[q] ??= []).push({
        x: c.totalImpressions,
        y: c.blendedCtr,
        z: c.keywordCount,
        topic: c.topic,
        clicks: c.totalClicks,
        quadrant: q,
      });
    }
    return groups;
  }, [chartClusters]);

  const tableClusters = quadrantFilter
    ? realClusters.filter((c) => c.quadrant === quadrantFilter)
    : realClusters;

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const progressPct =
    activeRun && activeRun.progressTotal > 0
      ? Math.min(100, Math.round((activeRun.progressDone / activeRun.progressTotal) * 100))
      : null;

  const selectedRunParams = selectedRun?.params as {
    weeks?: number | null;
    days?: number | null;
    window?: { currentStart: string; currentEnd: string; priorStart: string; priorEnd: string } | null;
    keywordLimit?: number | null;
  } | null;

  return (
    <div className="max-w-6xl space-y-6 pb-20">
      <div>
        <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
          <Boxes className="h-6 w-6 text-primary" />
          Keyword Clusters
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-4xl leading-relaxed">
          Groups your top Search Console queries by real Google search intent: two
          keywords land in the same cluster when they share at least 3 of the same
          ranking URLs. Each cluster shows your page vs the competitor pages winning
          the clicks, measured across strictly equal current vs prior windows.
        </p>
        <div className="mt-3">
          <JobSpendCapNotice jobName="keyword_clustering" suppressed={!!failedLatest} />
        </div>
      </div>

      <HowThisWorks
        summary="Groups your Google Search Console keywords into topic clusters based on which pages actually show up in Google for them. Compares performance between two exactly equal time windows."
        steps={[
          {
            title: "Start a run",
            body: "Choose how many weeks of data to analyze, how many keywords to include, and which country's Google results to check, then press Start clustering. A fresh run uses paid search credits.",
          },
          {
            title: "Wait a few minutes",
            body: "The page tracks progress automatically as it pulls your queries, checks Google, and groups them.",
          },
          {
            title: "Read the map",
            body: "The chart sorts clusters by current impressions versus click-through rate. The table lists clusters alongside their movement states (e.g., Rising, Displaced) so you can see which topics are gaining or losing ground.",
          },
          {
            title: "Open a cluster",
            body: "Expand any row to see the exact queries, their individual current vs prior performance, movement state, and the competitor pages ranking in the same search results.",
          },
          {
            title: "Improve names for free",
            body: "Use “Improve cluster names” to re-group and rename an existing run from data already stored — no new scraping cost.",
          },
        ]}
        faqs={[
          {
            title: "Does running this cost money?",
            body: "Yes — a fresh run scrapes one live Google results page per keyword and uses paid SERP credits. The dollar estimate is shown by the Start button. Rebuilding or renaming an existing run is free.",
          },
          {
            title: "How does the comparison window work?",
            body: "The report takes your selected number of weeks, ending 3 days ago, and compares it to the exact equal prior window. It classifies keywords into states like Rising or Displaced based on how clicks and impressions moved between the two periods.",
          },
          {
            title: "Why are some keywords “unclustered”?",
            body: "Two keywords only join the same cluster when they share at least 3 of the same ranking pages in Google. Keywords too unique to match anything are left out.",
          },
        ]}
        tips={[
          "Look for 'Striking Distance' keywords inside 'Opportunities' clusters — these are quick wins where small ranking improvements yield huge CTR jumps.",
          "Start with a smaller keyword count to keep the cost low, then run bigger once you trust the results.",
        ]}
      />

      <Card className="border-border/60 bg-muted/20">
        <CardContent className="pt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
            Understanding the Comparison
          </div>
          <div className="grid gap-x-6 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
            <ul className="list-disc pl-4 space-y-1">
              <li>Anonymized queries don't perfectly reconcile to total property metrics.</li>
              <li>Weekly and long-range calls yield different datasets; this report strictly uses weekly.</li>
              <li>The latest 3 days are excluded because Google's data is typically incomplete.</li>
            </ul>
            <ul className="list-disc pl-4 space-y-1">
              <li>Recent and final data can still be revised by Google.</li>
              <li>Thresholds used (30%, 10%, CTR 0.5%, positions 5–15, min 10 impressions) are product starting points, not Google rules.</li>
            </ul>
          </div>
          <div className="text-[11px] text-amber-600/90 dark:text-amber-500/90 font-medium pt-1">
            Note: If you encounter a service-account 403 error, verify your GSC API permissions directly in Search Console. Granting project IAM roles is not sufficient.
          </div>
        </CardContent>
      </Card>

      {/* Run form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New clustering run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1 mb-1">
                GSC duration
                <InfoTip>How many weeks of data to pull. We compare this equal period to the previous period.</InfoTip>
              </label>
              <div className="flex items-center gap-3 bg-muted/30 px-3 py-2 rounded-md border border-border/50">
                <input
                  type="range"
                  min={4}
                  max={52}
                  step={1}
                  value={weeks}
                  onChange={(e) => setWeeks(Number(e.target.value))}
                  className="flex-1 accent-primary"
                  data-testid="input-weeks-range"
                />
                <span className="text-sm font-semibold w-16 text-right tabular-nums">{weeks} weeks</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-2 space-y-1 bg-muted/20 px-2.5 py-2 rounded border border-border/40" data-testid="text-preview-dates">
                <div className="flex justify-between items-center">
                  <span className="font-medium text-foreground">Current:</span>
                  <span>{previewWindows.currentStart} – {previewWindows.currentEnd}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-medium text-foreground">Prior:</span>
                  <span>{previewWindows.priorStart} – {previewWindows.priorEnd}</span>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1">
                GSC country
                <InfoTip>Optionally limit the keywords to searches coming from one country in Search Console.</InfoTip>
              </label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1">
                Keywords to cluster
                <InfoTip>How many of your most-seen keywords to group. More keywords give a fuller map but cost more to scrape (one paid Google lookup each).</InfoTip>
              </label>
              <Input
                className="mt-1 tabular-nums"
                type="number"
                min={10}
                max={1000}
                value={keywordLimit}
                onChange={(e) => setKeywordLimit(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1">
                Google results location
                <InfoTip>Which country's Google results to check when grouping keywords. Pick the market you care about most.</InfoTip>
              </label>
              <Select value={locationCode} onValueChange={setLocationCode}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SERP_LOCATIONS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <label className="flex items-center gap-2 text-sm select-none cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                checked={excludeBrand}
                onChange={(e) => setExcludeBrand(e.target.checked)}
              />
              <span className="font-medium text-foreground">Exclude brand keywords</span>
              <InfoTip>Leaves out searches for your own brand name so they don't crowd out real topic opportunities.</InfoTip>
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                Scrapes one live Google page per keyword (~${estCost} per run)
                <InfoTip>Each keyword uses one paid Google-results lookup (a SERP credit). The dollar figure is the estimated cost for this run — bigger keyword counts cost more.</InfoTip>
              </span>
              <Button
                onClick={() => setConfirmRunOpen(true)}
                disabled={startMutation.isPending || !!activeRun}
                className="font-medium shadow-sm"
                data-testid="button-open-clustering-confirmation"
              >
                {startMutation.isPending || activeRun ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                {activeRun ? "Run in progress" : "Start clustering"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={confirmRunOpen}
        onOpenChange={(open) => {
          if (!startMutation.isPending) setConfirmRunOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="dialog-confirm-clustering-run">
          <DialogHeader>
            <DialogTitle>Confirm paid clustering run</DialogTitle>
            <DialogDescription>
              This run scrapes live Google results and uses paid SERP credits. Review the
              estimate before starting.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-medium text-foreground">Estimated SERP cost</span>
              <span className="text-lg font-semibold tabular-nums text-foreground" data-testid="text-confirmed-serp-estimate">
                ${estCost}
              </span>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <div className="flex justify-between gap-4">
                <dt>Keywords to scrape</dt>
                <dd className="font-medium text-foreground">{fmtInt(keywordCount)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Comparison period</dt>
                <dd className="font-medium text-foreground">{weeks} weeks</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Current window</dt>
                <dd className="font-medium text-foreground">{previewWindows.currentStart} – {previewWindows.currentEnd}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Prior window</dt>
                <dd className="font-medium text-foreground">{previewWindows.priorStart} – {previewWindows.priorEnd}</dd>
              </div>
            </dl>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRunOpen(false)}
              disabled={startMutation.isPending}
              data-testid="button-cancel-clustering-run"
            >
              Cancel
            </Button>
            <Button
              onClick={handleStart}
              disabled={startMutation.isPending}
              data-testid="button-confirm-clustering-run"
            >
              {startMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Approve and start run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Active run status */}
      {activeRun && (
        <Card className="border-primary/40 shadow-sm bg-primary/5">
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {PHASE_LABELS[activeRun.phase ?? ""] ?? "Starting…"}
            </div>
            {activeRun.phase === "fetching_serps" && activeRun.progressTotal > 0 && (
              <div className="space-y-1.5">
                <div className="h-2 w-full rounded-full bg-primary/20 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500 ease-out"
                    style={{ width: `${progressPct ?? 0}%` }}
                  />
                </div>
                <div className="text-xs font-medium text-primary/80 tabular-nums">
                  {fmtInt(activeRun.progressDone)} of {fmtInt(activeRun.progressTotal)} keyword
                  SERPs scraped
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {failedLatest && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-4 text-sm">
            <span className="font-semibold text-destructive capitalize">
              Last run {failedLatest.status}:
            </span>{" "}
            <span className="text-destructive/80 font-medium">{failedLatest.error ?? "Unknown error"}</span>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {completeRuns.length === 0 && !activeRun ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground font-medium">
            No clustering runs yet. Start one above — it takes a few minutes and the
            results stay saved here.
          </CardContent>
        </Card>
      ) : selectedRun ? (
        <>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-foreground">Showing run:</span>
              <Select
                value={String(selectedRun.id)}
                onValueChange={(v) => setSelectedRunId(Number(v))}
              >
                <SelectTrigger className="w-auto min-w-[280px] bg-card font-medium"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {completeRuns.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{runLabel(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedRun.stats && (
                <span className="text-xs text-muted-foreground font-medium">
                  {fmtInt(selectedRun.stats["clusters"] ?? 0)} clusters from{" "}
                  {fmtInt(selectedRun.stats["keywords"] ?? 0)} keywords
                  {(selectedRun.stats["unclustered"] ?? 0) > 0 &&
                    ` · ${fmtInt(selectedRun.stats["unclustered"] ?? 0)} unclustered`}
                  {(selectedRun.stats["operatorFiltered"] ?? 0) > 0 &&
                    ` · ${fmtInt(selectedRun.stats["operatorFiltered"] ?? 0)} junk excluded`}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRebuild(selectedRun.id)}
                disabled={rebuildMutation.isPending || !!activeRun}
                title="Re-groups and renames this run's clusters using the already-scraped Google results and AI naming — no new scraping cost."
                className="ml-auto bg-card"
              >
                {rebuildMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1.5 text-primary" />
                )}
                Improve cluster names (free)
              </Button>
            </div>

            {selectedRunParams?.window ? (
              <div className="text-[11.5px] font-medium bg-muted/40 border border-border/50 px-2.5 py-1.5 rounded-md inline-flex items-center gap-3" data-testid="text-run-window">
                <span>Comparing <span className="font-semibold text-foreground">{selectedRunParams.weeks} weeks</span>:</span>
                <span><span className="text-foreground">{formatWindowDate(selectedRunParams.window.currentStart)} – {formatWindowDate(selectedRunParams.window.currentEnd)}</span> (Current)</span>
                <span className="text-muted-foreground">vs</span>
                <span><span className="text-foreground">{formatWindowDate(selectedRunParams.window.priorStart)} – {formatWindowDate(selectedRunParams.window.priorEnd)}</span> (Prior)</span>
              </div>
            ) : (
              <div className="text-[11.5px] font-medium text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 px-2.5 py-1.5 rounded-md inline-flex items-center" data-testid="text-run-legacy">
                Legacy run — no comparison data available. Start a new run to see current vs prior metrics.
              </div>
            )}
          </div>

          {selectedRun.error && (
            <p className="text-xs font-semibold text-destructive bg-destructive/10 p-2 rounded">
              {selectedRun.error}
            </p>
          )}

          {clustersQ.isLoading ? (
            <div className="flex justify-center py-12"><Spinner className="h-8 w-8 text-primary" /></div>
          ) : (
            <>
              {/* Quadrant summary */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(QUADRANT_META).map(([key, meta]) => {
                  const count = realClusters.filter((c) => c.quadrant === key).length;
                  const active = quadrantFilter === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setQuadrantFilter(active ? null : key)}
                      className={`rounded-xl border p-3.5 text-left transition-all duration-200 ${
                        active
                          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                          : "border-border/60 bg-card hover:border-border hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full shadow-sm"
                          style={{ backgroundColor: meta.color }}
                        />
                        <span className={`text-sm font-semibold ${active ? 'text-primary' : 'text-foreground'}`}>{meta.label}</span>
                        <span className="ml-auto text-sm font-bold">{count}</span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground font-medium leading-relaxed">{meta.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Scatter */}
              <Card>
                <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base flex items-center gap-1.5">
                    Impressions vs CTR
                    <InfoTip>Each bubble is a topic cluster. Left–right = how often it's seen (impressions); up–down = click-through rate; bubble size = how many keywords it holds. The dashed lines mark the middle (median) so you can see which quadrant each cluster falls in.</InfoTip>
                  </CardTitle>
                  <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                      checked={showOutliers}
                      onChange={(e) => setShowOutliers(e.target.checked)}
                    />
                    Show outliers
                    <InfoTip>Outliers are unusual clusters (for example, one giant catch-all topic) hidden by default so they don't distort the chart. Tick this to include them.</InfoTip>
                  </label>
                </CardHeader>
                <CardContent>
                  <div className="h-[420px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                        <XAxis
                          type="number"
                          dataKey="x"
                          name="Impressions"
                          tickFormatter={(v: number) => fmtInt(v)}
                          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                          label={{
                            value: "Total impressions",
                            position: "insideBottom",
                            offset: -5,
                            fontSize: 11,
                            fill: "var(--color-muted-foreground)",
                            fontWeight: 500
                          }}
                        />
                        <YAxis
                          type="number"
                          dataKey="y"
                          name="CTR"
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                          label={{
                            value: "Blended CTR",
                            angle: -90,
                            position: "insideLeft",
                            fontSize: 11,
                            fill: "var(--color-muted-foreground)",
                            fontWeight: 500
                          }}
                        />
                        <ZAxis type="number" dataKey="z" range={[60, 400]} name="Keywords" />
                        <ReferenceLine
                          x={medImp}
                          stroke="#ef4444"
                          strokeDasharray="4 4"
                          label={{ value: "median", fontSize: 10, fill: "#ef4444", fontWeight: 600 }}
                        />
                        <ReferenceLine y={medCtr} stroke="#3b82f6" strokeDasharray="4 4" />
                        <RechartsTooltip
                          cursor={{ strokeDasharray: "3 3", stroke: "var(--color-muted-foreground)", opacity: 0.5 }}
                          content={({ payload }) => {
                            const d = payload?.[0]?.payload as ChartDatum | undefined;
                            if (!d) return null;
                            const meta = QUADRANT_META[d.quadrant];
                            return (
                              <div className="rounded-lg border border-border bg-popover/95 backdrop-blur px-3 py-2 text-xs shadow-lg">
                                <div className="font-semibold text-foreground text-sm">{d.topic}</div>
                                <div className="text-muted-foreground mt-1.5 space-y-0.5 font-medium">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta?.color }}></span>
                                    {meta?.label}
                                  </div>
                                  <div>{fmtInt(d.x)} impressions · {d.y.toFixed(2)}% CTR</div>
                                  <div>{fmtInt(d.clicks)} clicks · {d.z} keywords</div>
                                </div>
                              </div>
                            );
                          }}
                        />
                        {Object.entries(chartByQuadrant).map(([q, data]) => (
                          <Scatter
                            key={q}
                            data={data}
                            fill={QUADRANT_META[q]?.color ?? "#94a3b8"}
                            fillOpacity={0.75}
                            className="transition-all duration-300 hover:fill-opacity-100 cursor-pointer"
                          />
                        ))}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Cluster table */}
              <Card>
                <CardHeader className="pb-3 border-b border-border/50">
                  <CardTitle className="text-base flex items-center gap-2">
                    {quadrantFilter
                      ? <><span className="w-3 h-3 rounded-full" style={{ backgroundColor: QUADRANT_META[quadrantFilter]?.color }}></span> {QUADRANT_META[quadrantFilter]?.label} clusters</>
                      : "All clusters"}{" "}
                    <span className="text-muted-foreground font-medium bg-muted/50 px-2 py-0.5 rounded-full text-xs">
                      {tableClusters.length}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0 py-0">
                  <Table>
                    <TableHeader className="bg-muted/20">
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>
                          <span className="inline-flex items-center gap-1">
                            Cluster topic
                            <InfoTip>An AI-picked name for this group of related keywords, based on the searches inside it.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead>
                          <span className="inline-flex items-center gap-1">
                            Group
                            <InfoTip>Which quadrant this topic falls in based on its overall clicks vs impressions.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            Size
                            <InfoTip>How many of your keywords matched into this topic.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead>
                          <span className="inline-flex items-center gap-1">
                            Movement
                            <InfoTip>How keywords in this cluster moved since the prior equivalent window.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            Clicks
                            <InfoTip>Total clicks in the current window, compared to the prior window.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            Impr.
                            <InfoTip>Total impressions in the current window, compared to the prior window.</InfoTip>
                          </span>
                        </TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            CTR
                            <InfoTip>Blended click-through rate for the cluster as a whole in the current window.</InfoTip>
                          </span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableClusters.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">
                            No clusters match your filter.
                          </TableCell>
                        </TableRow>
                      ) : (
                        tableClusters.map((cRaw) => {
                          const c = cRaw as KeywordCluster;
                          const isExpanded = expandedId === c.clusterKey;
                          return (
                            <React.Fragment key={c.clusterKey}>
                              <TableRow
                                className={`cursor-pointer transition-colors ${
                                  isExpanded ? "bg-muted/10 hover:bg-muted/10" : "hover:bg-muted/30"
                                }`}
                                onClick={() =>
                                  setExpandedId(isExpanded ? null : c.clusterKey)
                                }
                              >
                                <TableCell>
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </TableCell>
                                <TableCell>
                                  <span className="font-semibold text-foreground text-sm">{c.topic}</span>
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    className={`text-[10px] px-1.5 py-0 border-transparent shadow-none ${QUADRANT_META[c.quadrant ?? "underperformers"]?.badge}`}
                                    variant="outline"
                                  >
                                    {QUADRANT_META[c.quadrant ?? "underperformers"]?.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right font-medium tabular-nums">{fmtInt(c.keywordCount)}</TableCell>
                                <TableCell>
                                  {c.stateCounts ? (
                                    <div className="flex flex-wrap gap-1 w-[180px]">
                                      {Object.entries(c.stateCounts).filter(([_, count]) => (count as number) > 0).map(([state, count]) => (
                                         <Badge key={state} variant="outline" className={`text-[10px] px-1.5 py-0 shadow-none border-transparent ${stateColors[state as keyof typeof stateColors] ?? stateColors.stable}`} title={stateLabels[state as keyof typeof stateLabels]}>
                                           <span className="font-bold mr-1">{count as number}</span> {stateLabels[state as keyof typeof stateLabels] ?? state}
                                         </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-[11px] font-medium text-muted-foreground italic">N/A</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right align-top">
                                  <div className="flex flex-col items-end gap-0.5 tabular-nums">
                                    <span className="font-medium text-foreground text-sm">{fmtInt(c.totalClicks)}</span>
                                    {c.priorTotalClicks != null && (
                                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                        {formatRatioNode(c.clickDeltaRatio, c.priorTotalClicks === 0 && c.totalClicks > 0)}
                                        {c.clickDeltaAbs != null && c.clickDeltaAbs !== 0 && (
                                          <span className="ml-1 opacity-70" title="Absolute change">({c.clickDeltaAbs > 0 ? "+" : ""}{fmtInt(c.clickDeltaAbs)})</span>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right align-top">
                                  <div className="flex flex-col items-end gap-0.5 tabular-nums">
                                    <span className="font-medium text-foreground text-sm">{fmtInt(c.totalImpressions)}</span>
                                    {c.priorTotalImpressions != null && (
                                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                        {formatRatioNode(c.impressionDeltaRatio, c.priorTotalImpressions === 0 && c.totalImpressions > 0)}
                                        {c.impressionDeltaAbs != null && c.impressionDeltaAbs !== 0 && (
                                          <span className="ml-1 opacity-70" title="Absolute change">({c.impressionDeltaAbs > 0 ? "+" : ""}{fmtInt(c.impressionDeltaAbs)})</span>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right align-top">
                                  <div className="flex flex-col items-end gap-0.5 tabular-nums">
                                    <span className="font-medium text-foreground text-sm">{c.blendedCtr.toFixed(1)}%</span>
                                    {c.priorBlendedCtr != null && (
                                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                        prev {c.priorBlendedCtr.toFixed(1)}%
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                              {isExpanded && (
                                <TableRow>
                                  <TableCell colSpan={8} className="p-0 bg-muted/20 border-b border-border shadow-inner">
                                    <ExpandedClusterDetail cluster={c} />
                                  </TableCell>
                                </TableRow>
                              )}
                            </React.Fragment>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Unclustered */}
              {unclusteredRow && !quadrantFilter && (
                <div className="rounded-lg border border-border/60 bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-1">
                    Unclustered keywords ({fmtInt(unclusteredRow.keywordCount)})
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    These queries didn't share enough top-ranking pages with other keywords to form a
                    cluster. Together they drew {fmtInt(unclusteredRow.totalImpressions)} impressions
                    and {fmtInt(unclusteredRow.totalClicks)} clicks.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}