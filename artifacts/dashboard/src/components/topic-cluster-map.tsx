import { useCallback, useMemo } from "react";
import {
  type TopicalMapDetail,
  type TopicalMapNode,
} from "@workspace/api-client-react";

type StatusFilter = Record<TopicalMapNode["status"], boolean>;
type PriorityFilter = Record<"high" | "medium" | "low", boolean>;

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 640;
const CENTER_X = MAP_WIDTH / 2;
const CENTER_Y = MAP_HEIGHT / 2;

function shortLabel(value: string, maxLength = 26): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function clusterColor(coveragePct: number): string {
  if (coveragePct >= 75) return "#10b981";
  if (coveragePct >= 40) return "#2563eb";
  return "#f59e0b";
}

export function TopicClusterMap({
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
  const { map, nodes, coverage } = detail;

  const pillars = useMemo(() => {
    const childrenOf = new Map<number, TopicalMapNode[]>();
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const children = childrenOf.get(node.parentId) ?? [];
      children.push(node);
      childrenOf.set(node.parentId, children);
    }

    const visibleCache = new Map<number, boolean>();
    const isVisible = (node: TopicalMapNode): boolean => {
      const cached = visibleCache.get(node.id);
      if (cached !== undefined) return cached;
      const visible =
        (statusFilter[node.status] &&
          priorityFilter[node.priority as keyof PriorityFilter]) ||
        (childrenOf.get(node.id) ?? []).some(isVisible);
      visibleCache.set(node.id, visible);
      return visible;
    };

    return nodes
      .filter((node) => node.level === "pillar" && isVisible(node))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }, [nodes, priorityFilter, statusFilter]);

  const coverageByPillar = useMemo(
    () => new Map(coverage.perPillar.map((pillar) => [pillar.nodeId, pillar.coveragePct])),
    [coverage.perPillar],
  );

  const positions = useMemo(() => {
    const count = pillars.length;
    if (count === 0) return [];
    const radiusX = count > 8 ? 360 : 320;
    const radiusY = count > 8 ? 235 : 205;
    return pillars.map((pillar, index) => {
      const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
      return {
        pillar,
        x: CENTER_X + Math.cos(angle) * radiusX,
        y: CENTER_Y + Math.sin(angle) * radiusY,
        coveragePct: coverageByPillar.get(pillar.id) ?? 0,
      };
    });
  }, [coverageByPillar, pillars]);

  const select = useCallback(
    (nodeId: number) => onSelectNode(nodeId),
    [onSelectNode],
  );

  if (pillars.length === 0) {
    return (
      <div
        className="rounded-xl border border-dashed bg-muted/20 px-4 py-12 text-center"
        data-testid="empty-topic-cluster-map"
      >
        <p className="text-sm font-medium">No clusters match the active filters</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Turn a status or priority back on to restore the cluster map.
        </p>
      </div>
    );
  }

  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      aria-labelledby="topic-cluster-map-heading"
      data-testid="topic-cluster-map"
    >
      <div className="flex flex-col justify-between gap-3 border-b bg-muted/15 px-4 py-4 sm:flex-row sm:items-end sm:px-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Cluster map
          </p>
          <h2 id="topic-cluster-map-heading" className="mt-1 text-lg font-semibold">
            {map.centralEntity}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each connected node is a topic cluster. Select one to inspect its
            coverage and page match.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            Strong coverage
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
            Building coverage
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
            Coverage gap
          </span>
        </div>
      </div>
      <div className="overflow-x-auto bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.07),transparent_55%)] p-2 sm:p-4">
        <svg
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          className="h-auto min-w-[760px] w-full"
          role="group"
          aria-label={`Topic cluster map for ${map.centralEntity}`}
        >
          <title>Topic cluster map for {map.centralEntity}</title>
          {positions.map(({ pillar, x, y }) => (
            <line
              key={`line-${pillar.id}`}
              x1={CENTER_X}
              y1={CENTER_Y}
              x2={x}
              y2={y}
              stroke="hsl(var(--muted-foreground) / 0.28)"
              strokeWidth="2"
              strokeDasharray="5 7"
            />
          ))}

          <g>
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r="82"
              fill="hsl(var(--primary))"
              stroke="hsl(var(--primary) / 0.25)"
              strokeWidth="12"
            />
            <text
              x={CENTER_X}
              y={CENTER_Y - 7}
              textAnchor="middle"
              fill="white"
              fontSize="18"
              fontWeight="700"
            >
              Central entity
            </text>
            <text
              x={CENTER_X}
              y={CENTER_Y + 20}
              textAnchor="middle"
              fill="white"
              fontSize="14"
            >
              {shortLabel(map.centralEntity, 24)}
            </text>
          </g>

          {positions.map(({ pillar, x, y, coveragePct }) => {
            const isSelected = selectedNodeId === pillar.id;
            const color = clusterColor(coveragePct);
            const labelY = y + 58;
            return (
              <g
                key={pillar.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${pillar.title} cluster details, ${coveragePct}% covered`}
                aria-pressed={isSelected}
                className="cursor-pointer outline-none"
                onClick={() => select(pillar.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(pillar.id);
                  }
                }}
                data-testid={`button-cluster-map-node-${pillar.id}`}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={isSelected ? 48 : 42}
                  fill="white"
                  stroke={color}
                  strokeWidth={isSelected ? 7 : 4}
                />
                <circle cx={x} cy={y} r="30" fill={color} opacity="0.13" />
                <text
                  x={x}
                  y={y + 5}
                  textAnchor="middle"
                  fill={color}
                  fontSize="16"
                  fontWeight="700"
                >
                  {coveragePct}%
                </text>
                <text
                  x={x}
                  y={labelY}
                  textAnchor="middle"
                  fill="hsl(var(--foreground))"
                  fontSize="14"
                  fontWeight={isSelected ? "700" : "600"}
                >
                  {shortLabel(pillar.title)}
                </text>
                <text
                  x={x}
                  y={labelY + 18}
                  textAnchor="middle"
                  fill="hsl(var(--muted-foreground))"
                  fontSize="12"
                >
                  topic cluster
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}