import { useMemo, useState } from "react";
import {
  getGetTopicalMapRunQueryKey,
  getListTopicalMapRunsQueryKey,
  type TopicalMapNode,
  type TopicalMapSummary,
  useGetTopicalMapRun,
  useListTopicalMapRuns,
} from "@workspace/api-client-react";
import { Boxes, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TopicalMapOverview } from "@/components/topical-map-overview";

type StatusFilter = Record<TopicalMapNode["status"], boolean>;
type PriorityFilter = Record<"high" | "medium" | "low", boolean>;

const DEFAULT_STATUS_FILTER: StatusFilter = {
  published: true,
  gap: true,
  ignored: true,
};

const DEFAULT_PRIORITY_FILTER: PriorityFilter = {
  high: true,
  medium: true,
  low: true,
};

function runLabel(run: TopicalMapSummary): string {
  const date = new Date(run.createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} — ${run.centralEntity}`;
}

export default function TopicClustersPage() {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>(DEFAULT_STATUS_FILTER);
  const [priorityFilter, setPriorityFilter] =
    useState<PriorityFilter>(DEFAULT_PRIORITY_FILTER);
  const [topicSearch, setTopicSearch] = useState("");

  const runsQuery = useListTopicalMapRuns({
    query: {
      queryKey: getListTopicalMapRunsQueryKey(),
    },
  });
  const completeRuns = (runsQuery.data ?? []).filter(
    (run) => run.status === "complete",
  );
  const selectedRun =
    completeRuns.find((run) => run.id === selectedRunId) ??
    completeRuns[0] ??
    null;

  const detailQuery = useGetTopicalMapRun(selectedRun?.id ?? 0, {
    query: {
      queryKey: getGetTopicalMapRunQueryKey(selectedRun?.id ?? 0),
      enabled: selectedRun !== null,
      staleTime: 5 * 60 * 1000,
    },
  });
  const detail = detailQuery.data ?? null;
  const selectedNode =
    detail?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const topicMatches = useMemo(() => {
    const needle = topicSearch.trim().toLowerCase();
    if (!detail || needle.length < 2) return [];
    return detail.nodes
      .filter(
        (node) =>
          node.title.toLowerCase().includes(needle) ||
          node.canonicalQuery.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [detail, topicSearch]);

  const resetSelection = (runId: number) => {
    setSelectedRunId(runId);
    setSelectedNodeId(null);
    setStatusFilter(DEFAULT_STATUS_FILTER);
    setPriorityFilter(DEFAULT_PRIORITY_FILTER);
    setTopicSearch("");
  };

  return (
    <div className="space-y-6" data-testid="page-topic-clusters">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Boxes className="h-6 w-6" />
          Topic Clusters
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review your pillar, core, supporting, and outer topics as a readable
          hierarchy. The interactive network remains in Topical Map.
        </p>
      </div>

      {runsQuery.isLoading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading topic clusters…
          </CardContent>
        </Card>
      ) : completeRuns.length === 0 ? (
        <Card data-testid="empty-topic-clusters">
          <CardContent className="py-12 text-center">
            <Boxes className="mx-auto h-9 w-9 text-muted-foreground/30" />
            <h2 className="mt-3 text-lg font-medium">No topic clusters yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Generate a topical map first. Its cluster hierarchy will appear
              here as a separate, readable view.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                <CardTitle className="text-base">Cluster controls</CardTitle>
                {completeRuns.length > 1 && (
                  <Select
                    value={String(selectedRun?.id ?? "")}
                    onValueChange={(value) => resetSelection(Number(value))}
                  >
                    <SelectTrigger
                      className="w-full lg:w-[340px]"
                      data-testid="select-cluster-run"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {completeRuns.map((run) => (
                        <SelectItem key={run.id} value={String(run.id)}>
                          {runLabel(run)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(
                  [
                    {
                      key: "published" as const,
                      label: "Covered",
                      dot: "bg-emerald-500",
                    },
                    { key: "gap" as const, label: "Gap", dot: "bg-amber-500" },
                    {
                      key: "ignored" as const,
                      label: "Dismissed",
                      dot: "bg-slate-400",
                    },
                  ]
                ).map(({ key, label, dot }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      setStatusFilter((current) => ({
                        ...current,
                        [key]: !current[key],
                      }))
                    }
                    aria-pressed={statusFilter[key]}
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-1 transition-colors ${
                      statusFilter[key]
                        ? "border-border bg-muted/60 text-foreground"
                        : "border-transparent text-muted-foreground/50 line-through"
                    }`}
                    data-testid={`button-cluster-filter-${key}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
                    {label}
                  </button>
                ))}
                <span className="mx-0.5 text-muted-foreground/40">|</span>
                {(
                  [
                    { key: "high" as const, label: "High" },
                    { key: "medium" as const, label: "Medium" },
                    { key: "low" as const, label: "Low" },
                  ]
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      setPriorityFilter((current) => ({
                        ...current,
                        [key]: !current[key],
                      }))
                    }
                    aria-pressed={priorityFilter[key]}
                    className={`rounded-full border px-2.5 py-1 transition-colors ${
                      priorityFilter[key]
                        ? "border-border bg-muted/60 text-foreground"
                        : "border-transparent text-muted-foreground/50 line-through"
                    }`}
                    data-testid={`button-cluster-priority-${key}`}
                  >
                    {label} priority
                  </button>
                ))}
              </div>

              <div className="relative max-w-md">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={topicSearch}
                  onChange={(event) => setTopicSearch(event.target.value)}
                  placeholder="Find a topic or query…"
                  className="pl-8"
                  data-testid="input-cluster-search"
                />
                {topicSearch.trim().length >= 2 && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
                    {topicMatches.length > 0 ? (
                      topicMatches.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() => {
                            setSelectedNodeId(node.id);
                            setTopicSearch("");
                          }}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60"
                          data-testid={`cluster-search-result-${node.id}`}
                        >
                          <span className="truncate">{node.title}</span>
                          <span className="shrink-0 text-xs capitalize text-muted-foreground">
                            {node.level.replace("_", " ")}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        No matching topics.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {detailQuery.isLoading ? (
            <Card>
              <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />
                Loading cluster hierarchy…
              </CardContent>
            </Card>
          ) : detail ? (
            <>
              {selectedNode && (
                <Card data-testid="card-cluster-topic-detail">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Selected topic
                        </p>
                        <CardTitle className="mt-1 text-lg">
                          {selectedNode.title}
                        </CardTitle>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary" className="capitalize">
                          {selectedNode.level.replace("_", " ")}
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {selectedNode.status === "published"
                            ? "covered"
                            : selectedNode.status}
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {selectedNode.priority} priority
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-4 text-sm md:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Canonical query
                      </p>
                      <p className="mt-1">{selectedNode.canonicalQuery}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Page match
                      </p>
                      <p className="mt-1">
                        {selectedNode.matchedPagePath ?? "No matching page yet"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <TopicalMapOverview
                detail={detail}
                statusFilter={statusFilter}
                priorityFilter={priorityFilter}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Cluster data could not be loaded.
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}