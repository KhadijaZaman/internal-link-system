import { useMemo, useState } from "react";
import {
  useListClusterRuns,
  getListClusterRunsQueryKey,
  useStartClusterRun,
  useListClusterRunClusters,
  getListClusterRunClustersQueryKey,
  type ClusterRun,
  type KeywordCluster,
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
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Play,
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
    badge: "bg-amber-100 text-amber-800 border-amber-200",
  },
  stars: {
    label: "Stars",
    desc: "High impressions, high CTR — protect these",
    color: "#10b981",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  niche: {
    label: "Niche Performers",
    desc: "Low impressions, high CTR — expand coverage",
    color: "#3b82f6",
    badge: "bg-blue-100 text-blue-800 border-blue-200",
  },
  underperformers: {
    label: "Underperformers",
    desc: "Low impressions, low CTR",
    color: "#94a3b8",
    badge: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

const PHASE_LABELS: Record<string, string> = {
  fetching_queries: "Pulling top queries from Search Console…",
  posting_serp_tasks: "Sending keywords to DataForSEO…",
  fetching_serps: "Scraping live Google results…",
  clustering: "Building intent clusters…",
  saving: "Saving results…",
  done: "Done",
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
  return `${date} — ${r.params.days}d, ${kws ? `${fmtInt(kws)} keywords` : `up to ${r.params.keywordLimit} keywords`}`;
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
  const [days, setDays] = useState("90");
  const [country, setCountry] = useState("all");
  const [keywordLimit, setKeywordLimit] = useState("250");
  const [locationCode, setLocationCode] = useState("2840");
  const [excludeBrand, setExcludeBrand] = useState(true);

  const startMutation = useStartClusterRun();
  const handleStart = () => {
    const limit = Math.max(10, Math.min(1000, Number(keywordLimit) || 250));
    startMutation.mutate(
      {
        data: {
          days: Number(days),
          ...(country !== "all" ? { country } : {}),
          keywordLimit: limit,
          locationCode: Number(locationCode),
          excludeBrand,
        },
      },
      {
        onSuccess: () => {
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

  const estCost = ((Math.max(10, Math.min(1000, Number(keywordLimit) || 250)) * 0.0006)).toFixed(2);

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold flex items-center gap-2">
          <Boxes className="h-5 w-5 text-primary" />
          Keyword Clusters
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Groups your top Search Console queries by real Google search intent: two
          keywords land in the same cluster when they share at least 3 of the same
          ranking URLs. Each cluster shows your page vs the competitor pages winning
          the clicks.
        </p>
      </div>

      {/* Run form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New clustering run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground">GSC range</label>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="28">Last 28 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                  <SelectItem value="180">Last 180 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">GSC country</label>
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
              <label className="text-xs font-medium text-muted-foreground">
                Keywords to cluster (top by impressions)
              </label>
              <Input
                className="mt-1"
                type="number"
                min={10}
                max={1000}
                value={keywordLimit}
                onChange={(e) => setKeywordLimit(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Google results location
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={excludeBrand}
                onChange={(e) => setExcludeBrand(e.target.checked)}
              />
              Exclude brand keywords
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Scrapes one live Google page per keyword (~${estCost} per run)
              </span>
              <Button
                onClick={handleStart}
                disabled={startMutation.isPending || !!activeRun}
              >
                {startMutation.isPending || activeRun ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-1.5" />
                )}
                {activeRun ? "Run in progress" : "Start clustering"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Active run status */}
      {activeRun && (
        <Card className="border-primary/40">
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {PHASE_LABELS[activeRun.phase ?? ""] ?? "Starting…"}
            </div>
            {activeRun.phase === "fetching_serps" && activeRun.progressTotal > 0 && (
              <>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progressPct ?? 0}%` }}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmtInt(activeRun.progressDone)} of {fmtInt(activeRun.progressTotal)} keyword
                  SERPs scraped
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {failedLatest && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm">
            <span className="font-medium text-destructive capitalize">
              Last run {failedLatest.status}:
            </span>{" "}
            <span className="text-muted-foreground">{failedLatest.error ?? "Unknown error"}</span>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {completeRuns.length === 0 && !activeRun ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No clustering runs yet. Start one above — it takes a few minutes and the
            results stay saved here.
          </CardContent>
        </Card>
      ) : selectedRun ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Showing run:</span>
            <Select
              value={String(selectedRun.id)}
              onValueChange={(v) => setSelectedRunId(Number(v))}
            >
              <SelectTrigger className="w-auto min-w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {completeRuns.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>{runLabel(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRun.stats && (
              <span className="text-xs text-muted-foreground">
                {fmtInt(selectedRun.stats["clusters"] ?? 0)} clusters from{" "}
                {fmtInt(selectedRun.stats["keywords"] ?? 0)} keywords
                {(selectedRun.stats["unclustered"] ?? 0) > 0 &&
                  ` · ${fmtInt(selectedRun.stats["unclustered"] ?? 0)} unclustered`}
              </span>
            )}
          </div>

          {clustersQ.isLoading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
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
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        active ? "border-primary bg-primary/5" : "border-border/60 bg-card hover:border-border"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: meta.color }}
                        />
                        <span className="text-sm font-medium">{meta.label}</span>
                        <span className="ml-auto text-sm font-semibold">{count}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{meta.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Scatter */}
              <Card>
                <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">Impressions vs CTR</CardTitle>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-border"
                      checked={showOutliers}
                      onChange={(e) => setShowOutliers(e.target.checked)}
                    />
                    Show outliers
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
                          tick={{ fontSize: 11 }}
                          label={{
                            value: "Total impressions",
                            position: "insideBottom",
                            offset: -5,
                            fontSize: 11,
                          }}
                        />
                        <YAxis
                          type="number"
                          dataKey="y"
                          name="CTR"
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                          tick={{ fontSize: 11 }}
                          label={{
                            value: "Blended CTR",
                            angle: -90,
                            position: "insideLeft",
                            fontSize: 11,
                          }}
                        />
                        <ZAxis type="number" dataKey="z" range={[60, 400]} name="Keywords" />
                        <ReferenceLine
                          x={medImp}
                          stroke="#ef4444"
                          strokeDasharray="4 4"
                          label={{ value: "median", fontSize: 10, fill: "#ef4444" }}
                        />
                        <ReferenceLine y={medCtr} stroke="#3b82f6" strokeDasharray="4 4" />
                        <RechartsTooltip
                          cursor={{ strokeDasharray: "3 3" }}
                          content={({ payload }) => {
                            const d = payload?.[0]?.payload as ChartDatum | undefined;
                            if (!d) return null;
                            const meta = QUADRANT_META[d.quadrant];
                            return (
                              <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                                <div className="font-medium">{d.topic}</div>
                                <div className="text-muted-foreground mt-1 space-y-0.5">
                                  <div>{meta?.label}</div>
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
                          />
                        ))}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Cluster table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {quadrantFilter
                      ? `${QUADRANT_META[quadrantFilter]?.label} clusters`
                      : "All clusters"}{" "}
                    <span className="text-muted-foreground font-normal">
                      ({tableClusters.length})
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead>Cluster topic</TableHead>
                        <TableHead>Group</TableHead>
                        <TableHead className="text-right">Keywords</TableHead>
                        <TableHead className="text-right">Impressions</TableHead>
                        <TableHead className="text-right">Clicks</TableHead>
                        <TableHead className="text-right">CTR</TableHead>
                        <TableHead className="text-right">Avg pos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableClusters.map((c) => (
                        <ClusterRows
                          key={c.id}
                          cluster={c}
                          expanded={expandedId === c.id}
                          onToggle={() =>
                            setExpandedId(expandedId === c.id ? null : c.id)
                          }
                        />
                      ))}
                    </TableBody>
                  </Table>
                  {unclusteredRow && !quadrantFilter && (
                    <p className="px-4 pt-3 text-xs text-muted-foreground">
                      {fmtInt(unclusteredRow.keywordCount)} keywords didn't share enough
                      ranking URLs with others to form a cluster (
                      {fmtInt(unclusteredRow.totalImpressions)} impressions total).
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function ClusterRows({
  cluster,
  expanded,
  onToggle,
}: {
  cluster: KeywordCluster;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = cluster.quadrant ? QUADRANT_META[cluster.quadrant] : null;
  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/40" onClick={onToggle}>
        <TableCell className="pr-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="font-medium max-w-[280px] truncate">{cluster.topic}</TableCell>
        <TableCell>
          {meta && (
            <Badge variant="outline" className={meta.badge}>
              {meta.label}
            </Badge>
          )}
          {cluster.isOutlier && (
            <Badge variant="outline" className="ml-1 text-muted-foreground">
              outlier
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right">{fmtInt(cluster.keywordCount)}</TableCell>
        <TableCell className="text-right">{fmtInt(cluster.totalImpressions)}</TableCell>
        <TableCell className="text-right">{fmtInt(cluster.totalClicks)}</TableCell>
        <TableCell className="text-right">{cluster.blendedCtr.toFixed(2)}%</TableCell>
        <TableCell className="text-right">
          {cluster.avgPosition != null ? cluster.avgPosition.toFixed(1) : "—"}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={8} className="bg-muted/30 p-4">
            <div className="grid gap-4 lg:grid-cols-2">
              {/* keywords */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Keywords in this cluster
                </h4>
                <div className="rounded-md border border-border/60 bg-card divide-y divide-border/50 max-h-72 overflow-y-auto">
                  {cluster.keywords.map((k) => (
                    <div
                      key={k.query}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="truncate">{k.query}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {fmtInt(k.impressions)} imp · {fmtInt(k.clicks)} clicks
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {/* own vs competitors */}
              <div className="space-y-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Your pages ranking here
                  </h4>
                  {cluster.ownUrls.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic rounded-md border border-dashed border-border/60 px-3 py-2">
                      None of your pages rank in the top results for this cluster —
                      a content gap.
                    </p>
                  ) : (
                    <div className="rounded-md border border-emerald-200/60 bg-card divide-y divide-border/50">
                      {cluster.ownUrls.slice(0, 5).map((u) => (
                        <UrlRow key={u.url} u={u} own />
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Competitor pages winning clicks
                  </h4>
                  <div className="rounded-md border border-border/60 bg-card divide-y divide-border/50 max-h-56 overflow-y-auto">
                    {cluster.competitorUrls.map((u) => (
                      <UrlRow key={u.url} u={u} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function UrlRow({
  u,
  own = false,
}: {
  u: KeywordCluster["ownUrls"][number];
  own?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <a
        href={u.url}
        target="_blank"
        rel="noreferrer"
        className={`truncate hover:underline ${own ? "text-emerald-700 font-medium" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {u.url.replace(/^https?:\/\/(www\.)?/, "")}
      </a>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="ml-auto shrink-0 text-muted-foreground">
        {u.keywordCount} kw
        {u.bestPosition != null && ` · best #${Math.round(u.bestPosition)}`}
      </span>
    </div>
  );
}
