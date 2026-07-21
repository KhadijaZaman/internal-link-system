import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useGetKnowledgeGraph } from "@workspace/api-client-react";
import type {
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import {
  Search,
  Waypoints,
  ExternalLink,
  X,
  Link2,
  Sparkles,
  Layers,
} from "lucide-react";
import * as d3 from "d3";

const PALETTE = [
  "#0554F2", "#f59e0b", "#16a34a", "#dc2626", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#9333ea", "#ea580c",
  "#0d9488", "#4f46e5", "#ca8a04", "#e11d48", "#059669",
  "#2563eb", "#c026d3", "#84cc16", "#f97316", "#06b6d4",
];
const MISC_COLOR = "#94a3b8";

type SimNode = d3.SimulationNodeDatum & KnowledgeGraphNode & { r: number };
type SimEdge = d3.SimulationLinkDatum<SimNode> & {
  kind: KnowledgeGraphEdge["kind"];
  similarity: number | null;
};

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

export default function KnowledgeGraphPage() {
  const { data, isLoading } = useGetKnowledgeGraph();

  const [colorMode, setColorMode] = useState<"cluster" | "category">("cluster");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [edgeFilter, setEdgeFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ---- Site categories derived from URL structure (first path segment) ----
  const categories = useMemo(() => {
    const empty = {
      list: [] as Array<{ id: number; label: string; size: number }>,
      byNode: new Map<string, number>(),
    };
    if (!data) return empty;
    const segOf = (url: string): string => {
      try {
        const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
        return seg ? seg.toLowerCase() : "home";
      } catch {
        return "home";
      }
    };
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      const s = segOf(n.id);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const majors = [...counts.entries()]
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1]);
    const majorIdx = new Map(majors.map(([s], i) => [s, i]));
    const titleCase = (s: string) =>
      s === "home"
        ? "Home"
        : s
            .split("-")
            .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
            .join(" ");
    const list = majors.map(([s, c], i) => ({ id: i, label: titleCase(s), size: c }));
    const otherId = list.length;
    const otherCount = [...counts.values()].filter((c) => c < 3).reduce((a, c) => a + c, 0);
    if (otherCount > 0) list.push({ id: otherId, label: "Other pages", size: otherCount });
    const byNode = new Map<string, number>();
    for (const n of data.nodes) {
      byNode.set(n.id, majorIdx.get(segOf(n.id)) ?? otherId);
    }
    return { list, byNode };
  }, [data]);

  const groups = colorMode === "cluster" ? (data?.clusters ?? []) : categories.list;

  const groupIdOf = useCallback(
    (n: KnowledgeGraphNode): number =>
      colorMode === "cluster" ? n.clusterId : (categories.byNode.get(n.id) ?? 0),
    [colorMode, categories],
  );

  const groupColor = useCallback(
    (gid: number): string => {
      const label = groups[gid]?.label;
      if (label === "Miscellaneous" || label === "Other pages") return MISC_COLOR;
      return PALETTE[gid % PALETTE.length];
    },
    [groups],
  );

  const clusterColor = useCallback(
    (clusterId: number): string => {
      if (!data) return MISC_COLOR;
      const isMisc = data.clusters[clusterId]?.label === "Miscellaneous";
      return isMisc ? MISC_COLOR : PALETTE[clusterId % PALETTE.length];
    },
    [data],
  );

  // Refs so the canvas can recolor on mode switch without restarting the
  // force simulation (and so the view memo can filter without depending on
  // colorMode identity — the filter is always reset when the mode changes).
  const groupIdOfRef = useRef(groupIdOf);
  const groupColorRef = useRef(groupColor);
  groupIdOfRef.current = groupIdOf;
  groupColorRef.current = groupColor;

  // ---- Filtered view of the graph ----
  const view = useMemo(() => {
    if (!data) return null;
    let nodes = data.nodes;
    if (groupFilter !== "all") {
      const gid = Number(groupFilter);
      nodes = nodes.filter((n) => groupIdOfRef.current(n) === gid);
    }
    const ids = new Set(nodes.map((n) => n.id));
    let edges = data.edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    if (edgeFilter === "semantic") {
      edges = edges.filter((e) => e.kind === "semantic" || e.kind === "both");
    } else if (edgeFilter === "link") {
      edges = edges.filter((e) => e.kind === "link" || e.kind === "both");
    }
    return { nodes, edges };
  }, [data, groupFilter, edgeFilter]);

  const searchMatches = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q || !view) return new Set<string>();
    return new Set(
      view.nodes
        .filter(
          (n) =>
            n.id.toLowerCase().includes(q) ||
            (n.title ?? "").toLowerCase().includes(q),
        )
        .map((n) => n.id),
    );
  }, [debouncedSearch, view]);

  // Top matches for the results dropdown — most authoritative pages first.
  const searchResults = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q || !view) return [];
    return view.nodes
      .filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          (n.title ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, 10);
  }, [debouncedSearch, view]);

  const selected = useMemo(
    () => data?.nodes.find((n) => n.id === selectedId) ?? null,
    [data, selectedId],
  );

  const related = useMemo(() => {
    if (!data || !selectedId) return [];
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
    const rows: Array<{
      node: KnowledgeGraphNode;
      kind: KnowledgeGraphEdge["kind"];
      similarity: number | null;
    }> = [];
    for (const e of data.edges) {
      const otherId =
        e.source === selectedId ? e.target : e.target === selectedId ? e.source : null;
      if (!otherId) continue;
      const node = nodeMap.get(otherId);
      if (node) rows.push({ node, kind: e.kind, similarity: e.similarity ?? null });
    }
    const kindRank = { both: 0, semantic: 1, link: 2 } as const;
    rows.sort(
      (a, b) =>
        kindRank[a.kind] - kindRank[b.kind] ||
        (b.similarity ?? 0) - (a.similarity ?? 0) ||
        b.node.pagerank - a.node.pagerank,
    );
    return rows.slice(0, 12);
  }, [data, selectedId]);

  // ---- Canvas force simulation ----
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const simEdgesRef = useRef<SimEdge[]>([]);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const selectedRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const searchRef = useRef<Set<string>>(new Set());
  const drawRef = useRef<() => void>(() => {});
  const focusNodeRef = useRef<(id: string) => void>(() => {});

  selectedRef.current = selectedId;
  searchRef.current = searchMatches;

  useEffect(() => {
    drawRef.current();
  }, [selectedId, searchMatches, colorMode]);

  useEffect(() => {
    if (!view || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = 620;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const maxPr = Math.max(...view.nodes.map((n) => n.pagerank), 1e-9);
    const nodes: SimNode[] = view.nodes.map((n) => ({
      ...n,
      r: 3 + 13 * Math.sqrt(n.pagerank / maxPr),
    }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const edges: SimEdge[] = view.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      similarity: e.similarity ?? null,
    }));
    simNodesRef.current = nodes;
    simEdgesRef.current = edges;

    const draw = () => {
      const t = transformRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      const sel = selectedRef.current;
      const hov = hoverRef.current;
      const matches = searchRef.current;
      const hasEmphasis = !!sel || matches.size > 0;

      for (const e of edges) {
        const s = e.source as SimNode;
        const tg = e.target as SimNode;
        if (s.x == null || tg.x == null) continue;
        const touchesSel = sel && (s.id === sel || tg.id === sel);
        const semantic = e.kind === "semantic" || e.kind === "both";
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(tg.x!, tg.y!);
        if (semantic) {
          ctx.strokeStyle = touchesSel ? "#7c3aed" : "rgba(124, 58, 237, 0.35)";
          ctx.lineWidth = (touchesSel ? 2 : 1) / t.k;
          ctx.setLineDash(e.kind === "semantic" ? [4 / t.k, 3 / t.k] : []);
        } else {
          const linksOnly = edgeFilter === "link";
          ctx.strokeStyle = touchesSel
            ? "#64748b"
            : hasEmphasis
              ? "rgba(148, 163, 184, 0.12)"
              : linksOnly
                ? "rgba(100, 116, 139, 0.45)"
                : "rgba(148, 163, 184, 0.25)";
          ctx.lineWidth = (touchesSel ? 1.5 : linksOnly ? 0.9 : 0.6) / t.k;
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const isSel = n.id === sel;
        const isMatch = matches.has(n.id);
        const dim = hasEmphasis && !isSel && !isMatch && n.id !== hov;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.fillStyle = groupColorRef.current(groupIdOfRef.current(n));
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isSel || isMatch || n.id === hov) {
          ctx.strokeStyle = isSel ? "#0f172a" : "#f59e0b";
          ctx.lineWidth = 2 / t.k;
          ctx.stroke();
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = 0.8 / t.k;
          ctx.stroke();
        }
      }

      // Labels: biggest nodes, hovered, and selected.
      const labelWorthy = nodes
        .filter((n) => n.r >= 8 || n.id === sel || n.id === hov)
        .slice(0, 60);
      ctx.font = `${11 / t.k}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = "#334155";
      for (const n of labelWorthy) {
        if (n.x == null || n.y == null) continue;
        const label = n.title ?? pathOf(n.id);
        const short = label.length > 34 ? `${label.slice(0, 32)}…` : label;
        ctx.fillText(short, n.x + n.r + 3 / t.k, n.y + 3 / t.k);
      }
      ctx.restore();
    };
    drawRef.current = draw;

    const sim = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance((e) =>
            e.kind === "semantic" || e.kind === "both" ? 40 : 70,
          )
          .strength((e) =>
            e.kind === "semantic" || e.kind === "both" ? 0.5 : 0.08,
          ),
      )
      .force("charge", d3.forceManyBody().strength(-45))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collide",
        d3.forceCollide<SimNode>().radius((d) => d.r + 1.5),
      )
      .on("tick", draw);

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.15, 8])
      .on("zoom", (ev) => {
        transformRef.current = ev.transform;
        draw();
      });
    const selCanvas = d3.select(canvas);
    selCanvas.call(zoom);

    // Smoothly pan/zoom the camera to center a node (used by search results).
    focusNodeRef.current = (id: string) => {
      const n = nodeById.get(id);
      if (!n || n.x == null || n.y == null) return;
      const k = Math.min(Math.max(transformRef.current.k, 1.6), 3);
      const target = d3.zoomIdentity
        .translate(width / 2, height / 2)
        .scale(k)
        .translate(-n.x, -n.y);
      selCanvas.transition().duration(600).call(zoom.transform, target);
    };

    const findNode = (mx: number, my: number): SimNode | undefined => {
      const t = transformRef.current;
      const [x, y] = t.invert([mx, my]);
      const n = sim.find(x, y, 24 / t.k);
      if (!n) return undefined;
      const dx = (n.x ?? 0) - x;
      const dy = (n.y ?? 0) - y;
      return Math.hypot(dx, dy) <= n.r + 6 / t.k ? n : undefined;
    };

    const onClick = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      setSelectedId(n ? n.id : null);
    };
    const onMove = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      const next = n?.id ?? null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        canvas.style.cursor = next ? "pointer" : "grab";
        draw();
      }
    };
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("mousemove", onMove);

    return () => {
      sim.stop();
      selCanvas.on(".zoom", null);
      selCanvas.interrupt();
      focusNodeRef.current = () => {};
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousemove", onMove);
    };
  }, [view, edgeFilter]);

  const stats = useMemo(() => {
    if (!data) return null;
    let linkE = 0;
    let semE = 0;
    for (const e of data.edges) {
      if (e.kind === "link" || e.kind === "both") linkE++;
      if (e.kind === "semantic" || e.kind === "both") semE++;
    }
    return { linkE, semE };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-display font-semibold">Knowledge Graph</h1>
        <p className="text-muted-foreground text-sm">
          No pages found yet. Run a site crawl first — the knowledge graph is
          built from crawled pages and their stored embeddings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
            <Waypoints className="h-6 w-6 text-primary" />
            Knowledge Graph
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            A map of the site — every page is a dot, colored by detected
            topic cluster or by site category (blog, pricing, features…).
            Purple dashed lines are semantic relationships (from embeddings);
            gray lines are actual internal links.
          </p>
        </div>
      </div>

      <HowThisWorks
        summary="Pages are clustered by topic using internal links plus semantic similarity from stored embeddings — no AI calls, everything is computed from data already in the database."
        steps={[
          {
            title: "Every crawled page becomes a node",
            body: "Node size reflects internal PageRank (how much link authority the page holds). Node color is its topic cluster.",
          },
          {
            title: "Two kinds of connections",
            body: "Gray lines are real internal links found in page content. Purple dashed lines mean two pages are semantically similar (their embeddings are close) — even if they don't link to each other yet.",
          },
          {
            title: "Topic clusters are detected automatically",
            body: "A community-detection pass groups pages that are densely connected. Cluster labels come from the most common words in member URLs.",
          },
          {
            title: "Use it to find linking opportunities",
            body: "A purple dashed line with no gray line means two related pages that don't link to each other — a prime internal-linking opportunity. Click any node to see its relationships.",
          },
        ]}
        tips={[
          `Semantic edges currently cover ${data.embeddedPages} of ${data.totalPosts} crawled posts (the ones with stored embeddings). Coverage grows as the embedding job runs.`,
          "Filter to a single cluster to inspect one topic area closely.",
        ]}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-semibold">{data.totalPages}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Pages
              <InfoTip>{data.pageFilterLabel}</InfoTip>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-semibold">{data.clusters.length}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Topic clusters
              <InfoTip>
                Groups of densely connected pages detected automatically from
                the link + similarity structure.
              </InfoTip>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-semibold">{stats?.linkE ?? 0}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Link connections
              <InfoTip>
                Unique page pairs connected by at least one real in-content
                internal link.
              </InfoTip>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-semibold">{stats?.semE ?? 0}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Semantic connections
              <InfoTip>
                Page pairs whose embeddings are highly similar — related by
                meaning, whether or not they link to each other.
              </InfoTip>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Find a page by title or URL…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchFocused(true);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchResults[0]) {
                setSelectedId(searchResults[0].id);
                focusNodeRef.current(searchResults[0].id);
                setSearchFocused(false);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setSearchFocused(false);
                e.currentTarget.blur();
              }
            }}
            className="pl-8 pr-8"
          />
          {searchQuery && (
            <button
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearchQuery("");
                setDebouncedSearch("");
              }}
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {searchFocused && debouncedSearch.trim() && (
            <div
              className="absolute z-20 top-full mt-1 w-full rounded-md border bg-popover shadow-md max-h-80 overflow-y-auto"
              onMouseDown={(e) => e.preventDefault()}
            >
              {searchResults.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-muted-foreground">
                  No pages match "{debouncedSearch.trim()}"
                  {groupFilter !== "all" &&
                    " in the current cluster filter — try switching back to all clusters"}
                  .
                </p>
              ) : (
                <>
                  {searchResults.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        setSelectedId(n.id);
                        focusNodeRef.current(n.id);
                        setSearchFocused(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: groupColor(groupIdOf(n)),
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium truncate">
                          {n.title ?? pathOf(n.id)}
                        </span>
                        <span className="block text-[11px] text-muted-foreground truncate">
                          {pathOf(n.id)}
                        </span>
                      </span>
                    </button>
                  ))}
                  {searchMatches.size > searchResults.length && (
                    <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
                      +{searchMatches.size - searchResults.length} more — all
                      matches are highlighted on the map.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <Select
          value={colorMode}
          onValueChange={(v) => {
            setColorMode(v as "cluster" | "category");
            setGroupFilter("all");
          }}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cluster">Group by: Topic clusters</SelectItem>
            <SelectItem value="category">Group by: Site categories</SelectItem>
          </SelectContent>
        </Select>
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="w-[240px]">
            <SelectValue
              placeholder={
                colorMode === "cluster" ? "All clusters" : "All categories"
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {colorMode === "cluster" ? "All clusters" : "All categories"}
            </SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.label} ({g.size})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={edgeFilter} onValueChange={setEdgeFilter}>
          <SelectTrigger className="w-[210px]">
            <SelectValue placeholder="All connections" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All connections</SelectItem>
            <SelectItem value="semantic">Semantic only</SelectItem>
            <SelectItem value="link">Internal links only</SelectItem>
          </SelectContent>
        </Select>
        {debouncedSearch && (
          <Badge variant="secondary">
            {searchMatches.size} match{searchMatches.size === 1 ? "" : "es"}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        <Card className="overflow-hidden">
          <CardContent className="p-0" ref={containerRef}>
            <canvas ref={canvasRef} className="block" />
          </CardContent>
        </Card>

        <div className="space-y-4">
          {selected ? (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm leading-snug">
                    {selected.title ?? pathOf(selected.id)}
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 -mt-1"
                    onClick={() => setSelectedId(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <a
                  href={selected.id}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline break-all inline-flex items-center gap-1"
                >
                  {pathOf(selected.id)}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    style={{
                      backgroundColor: clusterColor(selected.clusterId),
                      color: "white",
                    }}
                  >
                    {data.clusters[selected.clusterId]?.label ?? "Topic"}
                  </Badge>
                  <Badge variant="outline">
                    {categories.list[categories.byNode.get(selected.id) ?? -1]
                      ?.label ?? selected.section}
                  </Badge>
                  {selected.hasEmbedding && (
                    <Badge variant="secondary" className="gap-1">
                      <Sparkles className="h-3 w-3" /> embedded
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div className="text-muted-foreground">PageRank</div>
                  <div className="text-right font-medium">
                    {selected.pagerank.toFixed(4)}
                  </div>
                  <div className="text-muted-foreground">Inbound links</div>
                  <div className="text-right font-medium">{selected.inboundCount}</div>
                  <div className="text-muted-foreground">Outbound links</div>
                  <div className="text-right font-medium">{selected.outboundCount}</div>
                  {selected.impressions != null && (
                    <>
                      <div className="text-muted-foreground">Impressions</div>
                      <div className="text-right font-medium">
                        {selected.impressions.toLocaleString()}
                      </div>
                    </>
                  )}
                  {selected.clicks != null && (
                    <>
                      <div className="text-muted-foreground">Clicks</div>
                      <div className="text-right font-medium">
                        {selected.clicks.toLocaleString()}
                      </div>
                    </>
                  )}
                  {selected.topQuery && (
                    <>
                      <div className="text-muted-foreground">Top query</div>
                      <div className="text-right font-medium truncate" title={selected.topQuery}>
                        {selected.topQuery}
                      </div>
                    </>
                  )}
                </div>
                {related.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Connected pages
                    </div>
                    <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                      {related.map((r) => (
                        <button
                          key={r.node.id}
                          onClick={() => setSelectedId(r.node.id)}
                          className="w-full text-left text-xs rounded px-2 py-1.5 hover:bg-muted flex items-center gap-2"
                        >
                          {r.kind === "link" ? (
                            <Link2 className="h-3 w-3 shrink-0 text-slate-400" />
                          ) : (
                            <Sparkles className="h-3 w-3 shrink-0 text-violet-500" />
                          )}
                          <span className="truncate flex-1">
                            {r.node.title ?? pathOf(r.node.id)}
                          </span>
                          {r.similarity != null && (
                            <span className="text-muted-foreground shrink-0">
                              {(r.similarity * 100).toFixed(0)}%
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" />
                  {colorMode === "cluster" ? "Topic clusters" : "Site categories"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 max-h-[520px] overflow-y-auto pr-1">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() =>
                      setGroupFilter(
                        groupFilter === String(g.id) ? "all" : String(g.id),
                      )
                    }
                    className={`w-full text-left text-xs rounded px-2 py-1.5 hover:bg-muted flex items-center gap-2 ${
                      groupFilter === String(g.id) ? "bg-muted" : ""
                    }`}
                  >
                    <span
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: groupColor(g.id) }}
                    />
                    <span className="truncate flex-1">{g.label}</span>
                    <span className="text-muted-foreground shrink-0">{g.size}</span>
                  </button>
                ))}
                <p className="text-[11px] text-muted-foreground pt-2 leading-relaxed">
                  Click a {colorMode === "cluster" ? "cluster" : "category"} to
                  isolate it. Click any node on the map for page details.
                  Scroll to zoom, drag to pan.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
