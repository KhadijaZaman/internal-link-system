import type { TopicalMapNode } from "@workspace/api-client-react";
import { rowsToTsv, tsvToCsv, type Cell } from "@/lib/clipboard";

export const TOPICAL_MAP_EXPORT_HEADERS = [
  "Topic",
  "Level",
  "Section",
  "Status",
  "Priority",
  "Funnel",
  "Estimated US Traffic",
  "US Search Volume",
  "Global Search Volume",
  "Canonical Query",
  "Matched Page",
  "GSC Clicks",
  "Competitor Domains",
];

type StatusFilter = Record<TopicalMapNode["status"], boolean>;
type PriorityFilter = Record<"high" | "medium" | "low", boolean>;

function demandExportValue(
  value: number | null,
  fetchedAt: string | null,
): number | string {
  if (value !== null) return value;
  return fetchedAt ? "No measurable volume" : "";
}

function depthFirstNodes(nodes: TopicalMapNode[]): TopicalMapNode[] {
  const childrenOf = new Map<number, TopicalMapNode[]>();
  const roots: TopicalMapNode[] = [];
  const sorted = [...nodes].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  for (const node of sorted) {
    if (node.parentId === null) roots.push(node);
    else {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentId, siblings);
    }
  }

  const output: TopicalMapNode[] = [];
  const visit = (node: TopicalMapNode) => {
    output.push(node);
    for (const child of childrenOf.get(node.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return output;
}

export function buildTopicalMapExportRows(
  nodes: TopicalMapNode[],
  statusFilter: StatusFilter,
  priorityFilter: PriorityFilter,
): Cell[][] {
  return depthFirstNodes(nodes)
    .filter(
      (node) =>
        statusFilter[node.status] &&
        priorityFilter[node.priority as "high" | "medium" | "low"],
    )
    .map((node) => [
      node.title,
      node.level.replace("_", " "),
      node.section,
      node.status === "published"
        ? "covered"
        : node.status === "gap"
          ? "gap"
          : "dismissed",
      node.priority,
      node.funnelStage,
      node.estimatedUsTraffic ?? "",
      demandExportValue(node.usSearchVolume, node.usVolumeFetchedAt),
      demandExportValue(node.globalSearchVolume, node.globalVolumeFetchedAt),
      node.canonicalQuery,
      node.matchedPagePath ?? "",
      node.gscClicks ?? "",
      (node.competitors ?? []).map((competitor) => competitor.domain).join(", "),
    ]);
}

export function topicalMapExportTsv(
  nodes: TopicalMapNode[],
  statusFilter: StatusFilter,
  priorityFilter: PriorityFilter,
): string {
  return rowsToTsv(
    TOPICAL_MAP_EXPORT_HEADERS,
    buildTopicalMapExportRows(nodes, statusFilter, priorityFilter),
  );
}

export function downloadTopicalMapCsv(
  centralEntity: string,
  nodes: TopicalMapNode[],
  statusFilter: StatusFilter,
  priorityFilter: PriorityFilter,
  filenamePrefix = "topical-map",
): void {
  const csv = tsvToCsv(topicalMapExportTsv(nodes, statusFilter, priorityFilter));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filenamePrefix}-${centralEntity.replace(/\s+/g, "-").toLowerCase()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}