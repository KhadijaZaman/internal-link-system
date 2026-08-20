import { useCallback, useMemo } from "react";
import {
  type TopicalMapDetail,
  type TopicalMapNode,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ChevronDown,
  ChevronsUp,
  Map as MapIcon,
  Sparkles,
} from "lucide-react";

const STATUS_COLOR_CLASSES: Record<TopicalMapNode["status"], string> = {
  published: "bg-emerald-500",
  gap: "bg-amber-500",
  ignored: "bg-slate-400",
};

type StatusFilter = Record<TopicalMapNode["status"], boolean>;
type PriorityFilter = Record<"high" | "medium" | "low", boolean>;

interface PillarStats {
  total: number;
  published: number;
  gaps: number;
  ignored: number;
  highPriorityGaps: number;
}

function PriorityIndicator({ node }: { node: TopicalMapNode }) {
  if (node.status !== "gap") return null;
  if (node.priority === "high") {
    return (
      <ChevronsUp
        aria-label="High-priority gap"
        className="h-3.5 w-3.5 shrink-0 text-rose-500"
      />
    );
  }
  if (node.priority === "low") {
    return (
      <ChevronDown
        aria-label="Low-priority gap"
        className="h-3.5 w-3.5 shrink-0 text-slate-400"
      />
    );
  }
  return null;
}

function TopicTreeNode({
  node,
  depth,
  childrenOf,
  visibleNodesCache,
  isNodeVisible,
  selectedNodeId,
  onSelectNode,
}: {
  node: TopicalMapNode;
  depth: number;
  childrenOf: Map<number, TopicalMapNode[]>;
  visibleNodesCache: Map<number, boolean>;
  isNodeVisible: (node: TopicalMapNode) => boolean;
  selectedNodeId: number | null;
  onSelectNode: (id: number) => void;
}) {
  const isContextOnly = !isNodeVisible(node);
  const isSelected = selectedNodeId === node.id;
  const visibleChildren = (childrenOf.get(node.id) ?? []).filter((child) =>
    visibleNodesCache.get(child.id),
  );

  return (
    <div
      className={depth === 0 ? "space-y-2.5" : "space-y-2 border-l-2 border-muted/70 pl-3"}
      data-testid={`tree-overview-node-${node.id}`}
    >
      <button
        type="button"
        disabled={isContextOnly}
        aria-pressed={isSelected}
        aria-label={`Open topic details for ${node.title}`}
        onClick={() => onSelectNode(node.id)}
        className={`group flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
          isSelected
            ? "bg-primary/8 text-primary"
            : "text-foreground hover:bg-muted/60 hover:text-primary"
        } ${isContextOnly ? "cursor-default opacity-45 grayscale" : ""}`}
        data-testid={`button-overview-node-${node.id}`}
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR_CLASSES[node.status]}`}
        />
        <span className="min-w-0 flex-1">
          <span className={`block leading-5 ${depth === 0 ? "font-medium" : "text-sm"}`}>
            {node.title}
          </span>
          {node.status === "published" && node.matchedPagePath && (
            <span
              className="mt-0.5 block truncate text-xs font-normal text-muted-foreground"
              title={node.matchedPagePath}
              data-testid={`text-overview-page-${node.id}`}
            >
              {node.matchedPagePath}
            </span>
          )}
        </span>
        {isContextOnly && (
          <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            Context
          </span>
        )}
        <PriorityIndicator node={node} />
      </button>

      {visibleChildren.length > 0 && (
        <div className="space-y-2.5">
          {visibleChildren.map((child) => (
            <TopicTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              childrenOf={childrenOf}
              visibleNodesCache={visibleNodesCache}
              isNodeVisible={isNodeVisible}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TopicalMapOverview({
  detail,
  statusFilter,
  priorityFilter,
  selectedNodeId,
  onSelectNode,
}: {
  detail: TopicalMapDetail;
  statusFilter: StatusFilter;
  priorityFilter: PriorityFilter;
  selectedNodeId: number | null;
  onSelectNode: (id: number) => void;
}) {
  const { nodes, coverage, map } = detail;

  const isNodeVisible = useCallback(
    (node: TopicalMapNode) =>
      statusFilter[node.status] &&
      priorityFilter[node.priority as keyof PriorityFilter],
    [priorityFilter, statusFilter],
  );

  const childrenOf = useMemo(() => {
    const children = new Map<number, TopicalMapNode[]>();
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    }
    return children;
  }, [nodes]);

  const visibleNodesCache = useMemo(() => {
    const cache = new Map<number, boolean>();
    const hasVisibleNode = (node: TopicalMapNode): boolean => {
      const cached = cache.get(node.id);
      if (cached !== undefined) return cached;
      const visible =
        isNodeVisible(node) ||
        (childrenOf.get(node.id) ?? []).some((child) => hasVisibleNode(child));
      cache.set(node.id, visible);
      return visible;
    };
    for (const node of nodes) hasVisibleNode(node);
    return cache;
  }, [childrenOf, isNodeVisible, nodes]);

  const pillars = useMemo(
    () =>
      nodes
        .filter(
          (node) =>
            node.level === "pillar" && visibleNodesCache.get(node.id),
        )
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [nodes, visibleNodesCache],
  );

  const pillarStats = useMemo(() => {
    const stats = new Map<number, PillarStats>();
    for (const pillar of nodes.filter((node) => node.level === "pillar")) {
      const result: PillarStats = {
        total: 0,
        published: 0,
        gaps: 0,
        ignored: 0,
        highPriorityGaps: 0,
      };
      const stack = [pillar];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        result.total += 1;
        if (current.status === "published") result.published += 1;
        if (current.status === "gap") {
          result.gaps += 1;
          if (current.priority === "high") result.highPriorityGaps += 1;
        }
        if (current.status === "ignored") result.ignored += 1;
        stack.push(...(childrenOf.get(current.id) ?? []));
      }
      stats.set(pillar.id, result);
    }
    return stats;
  }, [childrenOf, nodes]);

  return (
    <div className="space-y-6 pb-6" data-testid="topical-map-overview">
      <div className="rounded-xl border bg-gradient-to-br from-primary/8 via-background to-emerald-500/5 p-4 sm:p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-primary">
              <Sparkles aria-hidden="true" className="h-4 w-4" />
              Central entity
            </p>
            <h2
              className="mt-1 truncate text-xl font-semibold"
              data-testid="text-overview-central-entity"
            >
              {map.centralEntity}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {coverage?.coveragePct ?? 0}% covered ·{" "}
              {coverage?.publishedNodes ?? 0} of {coverage?.totalNodes ?? 0} topics
            </p>
          </div>
          <div
            className="flex flex-wrap gap-x-4 gap-y-2 text-xs sm:justify-end"
            aria-label="Topic status legend"
          >
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              Covered
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              Gap
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-slate-400" />
              Dismissed
            </span>
          </div>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center rounded-lg border bg-card p-12 text-center"
          data-testid="empty-overview-topics"
        >
          <MapIcon aria-hidden="true" className="mb-2 h-8 w-8 text-muted-foreground/30" />
          <h3 className="text-lg font-medium">No topics overview</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            This run completed but didn't output any topics. Try regenerating with a broader
            charter.
          </p>
        </div>
      ) : pillars.length === 0 ? (
        <div
          className="rounded-lg border border-dashed bg-muted/20 px-4 py-10 text-center"
          data-testid="empty-overview-filtered"
        >
          <p className="text-sm font-medium">No topics match the active filters</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Turn a status or priority back on to restore the map outline.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-2">
          {pillars.map((pillar) => {
            const coverageForPillar = coverage?.perPillar.find(
              (entry) => entry.nodeId === pillar.id,
            );
            const stats = pillarStats.get(pillar.id);
            const childTopics = (childrenOf.get(pillar.id) ?? []).filter(
              (node) => visibleNodesCache.get(node.id),
            );
            const coreTopics = childTopics.filter(
              (node) => node.section === "core",
            );
            const outerTopics = childTopics.filter(
              (node) => node.section === "outer",
            );
            const pillarIsContextOnly = !isNodeVisible(pillar);

            return (
              <Card
                key={pillar.id}
                className="overflow-hidden shadow-sm"
                data-testid={`card-overview-pillar-${pillar.id}`}
              >
                <div className="border-b bg-muted/15 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      disabled={pillarIsContextOnly}
                      aria-pressed={selectedNodeId === pillar.id}
                      aria-label={`Open topic details for ${pillar.title}`}
                      onClick={() => onSelectNode(pillar.id)}
                      className={`min-w-0 text-left text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        selectedNodeId === pillar.id
                          ? "text-primary"
                          : "hover:text-primary"
                      } ${pillarIsContextOnly ? "cursor-default opacity-50" : ""}`}
                      data-testid={`button-overview-pillar-${pillar.id}`}
                    >
                      {pillar.title}
                    </button>
                    <Badge variant="secondary" className="shrink-0 tabular-nums">
                      {coverageForPillar?.coveragePct ?? 0}% covered
                    </Badge>
                  </div>
                  <Progress
                    value={coverageForPillar?.coveragePct ?? 0}
                    className="mt-3 h-1.5"
                  />
                  {stats && (
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                      <span
                        className="rounded-full bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700"
                        data-testid={`text-overview-covered-${pillar.id}`}
                      >
                        {stats.published} covered
                      </span>
                      <span
                        className="rounded-full bg-amber-500/10 px-2 py-1 font-medium text-amber-700"
                        data-testid={`text-overview-gaps-${pillar.id}`}
                      >
                        {stats.gaps} gaps
                      </span>
                      {stats.highPriorityGaps > 0 && (
                        <span
                          className="rounded-full bg-rose-500/10 px-2 py-1 font-medium text-rose-700"
                          data-testid={`text-overview-priority-${pillar.id}`}
                        >
                          {stats.highPriorityGaps} high priority
                        </span>
                      )}
                      {stats.ignored > 0 && (
                        <span className="rounded-full bg-slate-500/10 px-2 py-1 font-medium text-slate-600">
                          {stats.ignored} dismissed
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-6 p-4 sm:p-5">
                  {coreTopics.length > 0 && (
                    <section aria-labelledby={`heading-overview-core-${pillar.id}`}>
                      <h3
                        id={`heading-overview-core-${pillar.id}`}
                        className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground"
                      >
                        Core topics
                      </h3>
                      <div className="space-y-4">
                        {coreTopics.map((topic) => (
                          <TopicTreeNode
                            key={topic.id}
                            node={topic}
                            depth={0}
                            childrenOf={childrenOf}
                            visibleNodesCache={visibleNodesCache}
                            isNodeVisible={isNodeVisible}
                            selectedNodeId={selectedNodeId}
                            onSelectNode={onSelectNode}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {outerTopics.length > 0 && (
                    <section
                      className="border-t pt-5"
                      aria-labelledby={`heading-overview-outer-${pillar.id}`}
                    >
                      <h3
                        id={`heading-overview-outer-${pillar.id}`}
                        className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground"
                      >
                        Outer topics
                      </h3>
                      <div className="space-y-4">
                        {outerTopics.map((topic) => (
                          <TopicTreeNode
                            key={topic.id}
                            node={topic}
                            depth={0}
                            childrenOf={childrenOf}
                            visibleNodesCache={visibleNodesCache}
                            isNodeVisible={isNodeVisible}
                            selectedNodeId={selectedNodeId}
                            onSelectNode={onSelectNode}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}