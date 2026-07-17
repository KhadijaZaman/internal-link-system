import { useState, useRef, useEffect, useMemo } from "react";
import {
  useGetLinkGraph,
  useGetInventoryPage,
  getGetInventoryPageQueryKey,
  useGetLinkGraphFocus,
  getGetLinkGraphFocusQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Filter, AlertTriangle, Link2, Target, X, Sparkles, ArrowRight, ExternalLink, Network, Table as TableIcon, ArrowUpDown } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import * as d3 from "d3";
import type { LinkGraphNode, LinkGraphFocusNeighbor, LinkGraphFocus } from "@workspace/api-client-react";

function isFullUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

const DIR_COLOR: Record<LinkGraphFocusNeighbor["direction"], string> = {
  inbound: "#16a34a",
  outbound: "#0554F2",
  both: "#7c3aed",
  recommended: "#f59e0b",
};

const DIR_LABEL: Record<LinkGraphFocusNeighbor["direction"], string> = {
  inbound: "Inbound",
  outbound: "Outbound",
  both: "Both ways",
  recommended: "Recommended (missing)",
};

export default function LinkMap() {
  const { data: graph, isLoading } = useGetLinkGraph();
  const svgRef = useRef<SVGSVGElement>(null);
  const focusSvgRef = useRef<SVGSVGElement>(null);
  const queryClient = useQueryClient();

  const [orphansOnly, setOrphansOnly] = useState(false);
  const [deadEndsOnly, setDeadEndsOnly] = useState(false);
  const [sectionFilter, setSectionFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const focusUrl = useMemo(
    () => (isFullUrl(debouncedSearch) ? debouncedSearch.trim() : null),
    [debouncedSearch],
  );

  const {
    data: focus,
    isLoading: isLoadingFocus,
    error: focusError,
  } = useGetLinkGraphFocus(
    { url: focusUrl ?? "" },
    {
      query: {
        enabled: !!focusUrl,
        retry: false,
        queryKey: getGetLinkGraphFocusQueryKey({ url: focusUrl ?? "" }),
      },
    },
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { data: selectedPage, isLoading: isLoadingPage } = useGetInventoryPage(
    { url: selectedNodeId || "" },
    { query: { enabled: !!selectedNodeId, queryKey: getGetInventoryPageQueryKey({ url: selectedNodeId || "" }) } },
  );

  // Global force graph — only when NOT in focus mode
  useEffect(() => {
    if (focusUrl) return;
    if (!graph || !svgRef.current) return;

    let filteredNodes = graph.nodes;
    if (orphansOnly) filteredNodes = filteredNodes.filter((n) => n.isOrphan);
    if (deadEndsOnly) filteredNodes = filteredNodes.filter((n) => n.isDeadEnd);
    if (sectionFilter !== "all") filteredNodes = filteredNodes.filter((n) => n.section === sectionFilter);
    if (searchQuery && !isFullUrl(searchQuery)) {
      filteredNodes = filteredNodes.filter((n) => n.id.toLowerCase().includes(searchQuery.toLowerCase()));
    }

    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    const g = svg.append("g");

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", event.transform.toString());
      });
    svg.call(zoom);
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));

    const simulation = d3.forceSimulation<LinkGraphNode & d3.SimulationNodeDatum>(filteredNodes as any)
      .force("link", d3.forceLink<any, any>(filteredEdges).id((d: any) => d.id).distance(50))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(0, 0))
      .force("collide", d3.forceCollide().radius((d: any) => Math.sqrt((d as any).pagerank || 0) * 10 + 10));

    const link = g.append("g")
      .selectAll("line")
      .data(filteredEdges)
      .join("line")
      .attr("stroke", "hsl(var(--border))")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", 1);

    const node = g.append("g")
      .selectAll("circle")
      .data(filteredNodes as any)
      .join("circle")
      .attr("r", (d: any) => Math.max(4, Math.sqrt(d.pagerank || 0) * 20))
      .attr("fill", (d: any) => (d.section === "core" ? "hsl(var(--primary))" : "hsl(var(--secondary-foreground))"))
      .attr("stroke", (d: any) => ((d.isOrphan || d.isDeadEnd) ? "hsl(var(--destructive))" : "hsl(var(--background))"))
      .attr("stroke-width", (d: any) => ((d.isOrphan || d.isDeadEnd) ? 3 : 1.5))
      .style("cursor", "pointer")
      .on("click", (_event: any, d: any) => setSelectedNodeId(d.id))
      .call(d3.drag<SVGCircleElement, any>()
        .on("start", (event: any, d: any) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event: any, d: any) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event: any, d: any) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    node.append("title").text((d: any) => d.id);

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);
      node.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
    });

    return () => {
      simulation.stop();
    };
  }, [graph, orphansOnly, deadEndsOnly, sectionFilter, searchQuery, focusUrl]);

  // Focused hub-and-spoke render
  useEffect(() => {
    if (!focusUrl) return;
    if (!focus || !focusSvgRef.current) return;

    const svg = d3.select(focusSvgRef.current);
    svg.selectAll("*").remove();

    const width = focusSvgRef.current.clientWidth;
    const height = focusSvgRef.current.clientHeight;
    const cx = width / 2;
    const cy = height / 2;

    const g = svg.append("g");
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", event.transform.toString());
      });
    svg.call(zoom);

    const neighbors = focus.neighbors.slice(0, 24);
    const n = neighbors.length;
    const minR = 110;
    const maxR = Math.min(width, height) / 2 - 80;

    // Place neighbors radially: angle by index, distance inverse-proportional to score
    const positions = neighbors.map((nb, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      const r = minR + (1 - Math.max(0, Math.min(1, nb.totalScore))) * (maxR - minR);
      return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, neighbor: nb };
    });

    // Edges
    g.append("g")
      .selectAll("line")
      .data(positions)
      .join("line")
      .attr("x1", cx)
      .attr("y1", cy)
      .attr("x2", (d) => d.x)
      .attr("y2", (d) => d.y)
      .attr("stroke", (d) => DIR_COLOR[d.neighbor.direction])
      .attr("stroke-opacity", (d) => 0.35 + 0.5 * d.neighbor.totalScore)
      .attr("stroke-width", (d) => 1 + 2.5 * d.neighbor.totalScore)
      .attr("stroke-dasharray", (d) => (d.neighbor.direction === "recommended" ? "5,4" : "0"));

    // Neighbor nodes
    const nodeG = g.append("g")
      .selectAll("g.neighbor")
      .data(positions)
      .join("g")
      .attr("class", "neighbor")
      .attr("transform", (d) => `translate(${d.x},${d.y})`)
      .style("cursor", "pointer")
      .on("click", (_e, d) => setSelectedNodeId(d.neighbor.url));

    nodeG.append("circle")
      .attr("r", (d) => 8 + 14 * d.neighbor.totalScore)
      .attr("fill", (d) => DIR_COLOR[d.neighbor.direction])
      .attr("fill-opacity", 0.85)
      .attr("stroke", "white")
      .attr("stroke-width", 2);

    nodeG.append("title").text((d) => `${d.neighbor.url}\nScore: ${(d.neighbor.totalScore * 100).toFixed(0)}%`);

    nodeG.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => -(8 + 14 * d.neighbor.totalScore) - 6)
      .attr("font-size", 10)
      .attr("fill", "hsl(var(--foreground))")
      .text((d) => {
        const url = d.neighbor.url;
        try {
          const p = new URL(url).pathname;
          return p.length > 28 ? p.slice(0, 27) + "…" : p;
        } catch {
          return url.slice(0, 28);
        }
      });

    // Seed node (center)
    const seedG = g.append("g").attr("transform", `translate(${cx},${cy})`);
    seedG.append("circle")
      .attr("r", 36)
      .attr("fill", "hsl(var(--primary))")
      .attr("stroke", "white")
      .attr("stroke-width", 4);
    const seedLabel = (() => {
      const t = focus.seed.title?.trim();
      if (t) return t.length > 28 ? t.slice(0, 27) + "…" : t;
      try {
        const p = new URL(focus.seed.url).pathname.replace(/\/$/, "");
        const slug = p.split("/").filter(Boolean).pop() ?? "Home";
        return slug.length > 28 ? slug.slice(0, 27) + "…" : slug;
      } catch {
        return "This page";
      }
    })();
    seedG.append("title").text(focus.seed.title || focus.seed.url);
    seedG.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", 4)
      .attr("font-size", 11)
      .attr("font-weight", 600)
      .attr("fill", "white")
      .text(seedLabel);
  }, [focus, focusUrl]);

  const clearFocus = () => setSearchQuery("");

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex-none mb-4">
        <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
          Link Map
          <InfoTip>Force-directed visualization of your site's internal link graph. Enter a full URL in Search URL to see a focused view of that page's neighbors, with scores combining semantic relevance, popularity, and prominence.</InfoTip>
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">Interactive visualization of site structure</p>
        <div className="mt-3">
          <HowThisWorks
            summary="Force-directed view of every internal link on your site. Nodes are pages, edges are content-area links. Focused mode shows one page's neighborhood ranked by combined semantic / popularity / prominence score."
            steps={[
              { title: "Pick a view", body: "Leave the URL blank to see the global graph filtered by section and problem type. Paste a full URL into Search URL to switch to focused mode for that page." },
              { title: "Read the colors and sizes", body: "Outbound links are blue, inbound are green. Node size scales with link degree, so big nodes are hubs and tiny nodes are orphans or dead-ends." },
              { title: "Click a node to drill in", body: "Opens the side drawer with the page's title, tier, inbound/outbound counts, and the option to add the URL to the optimization queue." },
            ]}
            faqs={[
              { title: "Why are some links not shown?", body: "Only content-area links count — header, footer, and sidebar links are filtered out by the placement classifier so the graph reflects editorial linking only." },
              { title: "Why does my page look orphaned?", body: "Either nothing links to it from content, or those links were tagged as nav/sidebar. Check the Semantic Links Inbox for proposals targeting the page." },
            ]}
          />
        </div>
      </div>

      <div className="flex-1 flex gap-4 min-h-0 relative">
        <Card className="w-80 flex-none flex flex-col h-full border-border/50">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Filter className="h-4 w-4" /> Filters
              <InfoTip>Narrow the graph by URL search, section, or problem type. Paste a full URL (https://...) to switch to focused view for that page.</InfoTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 flex-1 overflow-y-auto">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                Search URL
                <InfoTip>Filter the global graph by substring, or paste a full URL to load the focused view.</InfoTip>
              </Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="/blog or https://..."
                  className="pl-9 pr-8"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    onClick={clearFocus}
                    className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                    aria-label="Clear"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {focusUrl && (
                <p className="text-xs text-primary flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> Focused view active
                </p>
              )}
            </div>

            {!focusUrl && (
              <>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    Section
                    <InfoTip>Limit to core (main money pages) or outer (supporting content) sections.</InfoTip>
                  </Label>
                  <Select value={sectionFilter} onValueChange={setSectionFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Sections" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sections</SelectItem>
                      <SelectItem value="core">Core</SelectItem>
                      <SelectItem value="outer">Outer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-4 pt-2">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="flex items-center gap-1.5">
                        Orphans Only
                        <InfoTip>Pages with zero inbound internal links.</InfoTip>
                      </Label>
                      <p className="text-xs text-muted-foreground">0 inbound links</p>
                    </div>
                    <Switch checked={orphansOnly} onCheckedChange={setOrphansOnly} />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="flex items-center gap-1.5">
                        Dead-ends Only
                        <InfoTip>Pages with zero outbound internal links.</InfoTip>
                      </Label>
                      <p className="text-xs text-muted-foreground">0 outbound links</p>
                    </div>
                    <Switch checked={deadEndsOnly} onCheckedChange={setDeadEndsOnly} />
                  </div>
                </div>
              </>
            )}

            <div className="mt-8 pt-4 border-t space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Legend</h4>
              {focusUrl ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ background: DIR_COLOR.inbound }} /> Inbound link
                    <InfoTip>Another page on your site links <em>to</em> the focused URL. More inbound links pass more PageRank to this page.</InfoTip>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ background: DIR_COLOR.outbound }} /> Outbound link
                    <InfoTip>The focused URL links <em>out to</em> another page on your site. Outbound links spread this page's PageRank to its neighbours.</InfoTip>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ background: DIR_COLOR.both }} /> Both ways
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ background: DIR_COLOR.recommended }} /> Recommended (missing)
                  </div>
                  <p className="text-xs text-muted-foreground pt-2">
                    Closer to center + thicker edge = higher combined score
                    (50% semantic relevance, 25% popularity, 25% prominence).
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full bg-primary" /> Core Page
                    <InfoTip>Tier-1 / tier-2 pillar page — main money pages and hubs that should pull the most internal links.</InfoTip>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full bg-secondary-foreground" /> Outer Page
                    <InfoTip>Tier-3 / tier-4 leaf page — supporting article, glossary entry, or thin content that feeds the core.</InfoTip>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full bg-transparent border-2 border-destructive" /> Orphan / Dead-end
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="flex-1 h-full border-border/50 relative overflow-hidden bg-card flex flex-col">
          {focusUrl ? (
            isLoadingFocus ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner className="h-8 w-8" />
              </div>
            ) : focusError || !focus ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
                <div className="font-medium">URL not found in inventory</div>
                <div className="text-sm text-muted-foreground max-w-md">
                  We don't have crawl data for{" "}
                  <span className="font-mono break-all">{focusUrl}</span>. Try
                  another URL or run a crawl.
                </div>
                <Button variant="outline" size="sm" onClick={clearFocus}>
                  Clear
                </Button>
              </div>
            ) : (
              <FocusView focus={focus} svgRef={focusSvgRef} onSelectUrl={setSelectedNodeId} />
            )
          ) : isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="h-8 w-8" />
            </div>
          ) : (
            <svg ref={svgRef} className="w-full h-full" />
          )}
        </Card>
      </div>

      <Drawer open={!!selectedNodeId} onOpenChange={(open) => !open && setSelectedNodeId(null)}>
        <DrawerContent className="h-[90vh]">
          <div className="max-w-5xl w-full mx-auto flex flex-col h-full">
            {isLoadingPage || !selectedPage ? (
              <div className="flex-1 flex items-center justify-center">
                <Spinner className="h-8 w-8" />
              </div>
            ) : (
              <>
                <DrawerHeader className="border-b pb-6 px-6 shrink-0">
                  <div className="flex items-start justify-between">
                    <div>
                      <DrawerTitle className="font-display tracking-wide text-2xl text-primary flex items-center gap-2">
                        {selectedPage.title || "Untitled Page"}
                      </DrawerTitle>
                      <DrawerDescription className="text-base text-foreground mt-1 flex items-center gap-2 font-mono">
                        <a
                          href={selectedPage.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1 truncate"
                          title={`Open ${selectedPage.url} in a new tab`}
                        >
                          <span className="truncate">{selectedPage.url}</span>
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        </a>
                        <Badge variant="outline">{selectedPage.section}</Badge>
                      </DrawerDescription>
                    </div>
                    <div className="flex gap-2">
                      {selectedPage.isOrphan && (
                        <Badge variant="destructive" className="flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Orphan
                        </Badge>
                      )}
                      {selectedPage.isDeadEnd && (
                        <Badge variant="destructive" className="flex items-center gap-1">
                          <Target className="h-3 w-3" /> Dead-end
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearchQuery(selectedPage.url);
                          setSelectedNodeId(null);
                          void queryClient.invalidateQueries();
                        }}
                      >
                        Focus on map
                      </Button>
                    </div>
                  </div>
                </DrawerHeader>

                <div className="p-6 overflow-y-auto flex-1 bg-muted/10">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <Card>
                      <CardContent className="p-4 space-y-1">
                        <div className="text-sm text-muted-foreground flex items-center gap-1">
                          PageRank
                          <InfoTip>
                            Internal PageRank — Google's algorithm run over <em>your</em> site's link graph only. Each inbound
                            link passes a fraction of the source page's score. Higher number = a page more pages link to (and
                            pages with higher PageRank linking to it count more). Use it to find which pages already hold equity
                            you can route into thin pages with internal links.
                          </InfoTip>
                        </div>
                        <div className="text-2xl font-bold font-mono">{(selectedPage.pagerank || 0).toFixed(4)}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 space-y-1">
                        <div className="text-sm text-muted-foreground">Top Query</div>
                        <div className="text-lg font-medium truncate">{selectedPage.topQuery || "N/A"}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 space-y-1">
                        <div className="text-sm text-muted-foreground">Position</div>
                        <div
                          className="text-2xl font-bold font-mono truncate"
                          title={selectedPage.position?.toString() ?? "-"}
                        >
                          {selectedPage.position != null ? Number(selectedPage.position).toFixed(1) : "-"}
                        </div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 space-y-1">
                        <div className="text-sm text-muted-foreground">Traffic</div>
                        <div className="text-2xl font-bold font-mono">
                          {selectedPage.clicks || 0} <span className="text-sm text-muted-foreground font-sans">clicks</span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card className="border-border/50">
                      <CardHeader className="py-4">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Link2 className="h-4 w-4 text-green-500" />
                          Inbound Links ({selectedPage.inboundCount})
                          <InfoTip>Other pages on the site that link to this page, with the anchor text used.</InfoTip>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        {selectedPage.inboundLinks.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-4 text-center">No inbound links</div>
                        ) : (
                          <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                            {selectedPage.inboundLinks.map((link, i) => (
                              <div key={i} className="text-sm space-y-1 pb-3 border-b last:border-0 last:pb-0">
                                <a
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-primary hover:underline truncate block"
                                  title={`Open ${link.url} in a new tab`}
                                >
                                  {link.url}
                                </a>
                                {(() => {
                                  const anchor = link.anchorText?.trim() ?? "";
                                  const isPlaceholder =
                                    anchor === "" ||
                                    anchor.toLowerCase() === "wp:auto" ||
                                    anchor.toLowerCase() === "auto";
                                  return isPlaceholder ? (
                                    <div className="text-xs italic text-muted-foreground">No anchor text captured</div>
                                  ) : (
                                    <div className="bg-secondary px-2 py-1 rounded inline-block text-xs font-medium">
                                      {anchor}
                                    </div>
                                  );
                                })()}
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="border-border/50">
                      <CardHeader className="py-4">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Link2 className="h-4 w-4 text-blue-500" />
                          Outbound Links ({selectedPage.outboundCount})
                          <InfoTip>Internal links this page sends out to other pages on the site.</InfoTip>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        {selectedPage.outboundLinks.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-4 text-center">No outbound links</div>
                        ) : (
                          <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                            {selectedPage.outboundLinks.map((link, i) => (
                              <div key={i} className="text-sm space-y-1 pb-3 border-b last:border-0 last:pb-0">
                                <a
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-primary hover:underline truncate block"
                                  title={`Open ${link.url} in a new tab`}
                                >
                                  {link.url}
                                </a>
                                {(() => {
                                  const anchor = link.anchorText?.trim() ?? "";
                                  const isPlaceholder =
                                    anchor === "" ||
                                    anchor.toLowerCase() === "wp:auto" ||
                                    anchor.toLowerCase() === "auto";
                                  return isPlaceholder ? (
                                    <div className="text-xs italic text-muted-foreground">No anchor text captured</div>
                                  ) : (
                                    <div className="bg-secondary px-2 py-1 rounded inline-block text-xs font-medium">
                                      {anchor}
                                    </div>
                                  );
                                })()}
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

interface FocusViewProps {
  focus: LinkGraphFocus;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onSelectUrl: (url: string) => void;
}

type NeighborFilter = "all" | "inbound" | "outbound" | "recommended";
type ViewMode = "map" | "table";
type SortKey = "score" | "url" | "anchor" | "relevance" | "popularity" | "prominence";

function FocusView({ focus, svgRef, onSelectUrl }: FocusViewProps) {
  const { seed, neighbors } = focus;
  const [filter, setFilter] = useState<NeighborFilter>("all");
  const [view, setView] = useState<ViewMode>("map");
  const matchesFilter = (d: string, f: NeighborFilter) => {
    if (f === "all") return true;
    if (f === "inbound") return d === "inbound" || d === "both";
    if (f === "outbound") return d === "outbound" || d === "both";
    return d === "recommended";
  };
  const inboundCount = neighbors.filter((n) => matchesFilter(n.direction, "inbound")).length;
  const outboundCount = neighbors.filter((n) => matchesFilter(n.direction, "outbound")).length;
  const recCount = neighbors.filter((n) => n.direction === "recommended").length;
  const visibleNeighbors = neighbors.filter((n) => matchesFilter(n.direction, filter));
  const toggle = (f: NeighborFilter) => setFilter((cur) => (cur === f ? "all" : f));
  const chipClass = (active: boolean) =>
    `px-2 py-0.5 rounded transition-colors cursor-pointer ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 pt-3 pb-2 border-b shrink-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <a
            href={seed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display tracking-wide text-primary hover:underline truncate"
            title={`Open ${seed.url} in a new tab`}
          >
            {seed.title || seed.url}
          </a>
          <Badge variant="outline">{seed.section}</Badge>
          <a
            href={seed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-primary hover:underline font-mono truncate"
            title={`Open ${seed.url} in a new tab`}
          >
            {seed.url}
          </a>
        </div>
        <div className="flex gap-2 mt-1 text-xs text-muted-foreground flex-wrap items-center">
          <button
            type="button"
            onClick={() => toggle("inbound")}
            aria-pressed={filter === "inbound"}
            className={chipClass(filter === "inbound")}
            title="Show only inbound links (pages linking to this one). Includes bidirectional links."
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: DIR_COLOR.inbound }} />
            {seed.inboundCount} inbound
          </button>
          <button
            type="button"
            onClick={() => toggle("outbound")}
            aria-pressed={filter === "outbound"}
            className={chipClass(filter === "outbound")}
            title="Show only outbound links (pages this one links to). Includes bidirectional links."
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: DIR_COLOR.outbound }} />
            {seed.outboundCount} outbound
          </button>
          <button
            type="button"
            onClick={() => toggle("recommended")}
            aria-pressed={filter === "recommended"}
            className={chipClass(filter === "recommended")}
            title="Show only recommended new links (suggestions to add)"
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: DIR_COLOR.recommended }} />
            {recCount} recommended
          </button>
          {filter !== "all" && (
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="text-primary hover:underline ml-1"
            >
              clear filter
            </button>
          )}
          {!seed.hasEmbedding && (
            <span className="text-amber-600">No embedding — scores limited; run Refresh Post Embeddings</span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground italic">
            In-text, same-domain links only
            <InfoTip>Inbound and outbound counts here are restricted to editorial body links on the same domain. Nav, footer, sidebar, and external links are excluded by the placement classifier so you see real editorial linking only.</InfoTip>
          </span>
          <div className="inline-flex rounded-md border border-border/60 overflow-hidden">
            <button
              type="button"
              onClick={() => setView("map")}
              aria-pressed={view === "map"}
              className={`px-2 py-1 inline-flex items-center gap-1 text-xs ${view === "map" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              title="Visual map view"
            >
              <Network className="h-3 w-3" /> Map
            </button>
            <button
              type="button"
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
              className={`px-2 py-1 inline-flex items-center gap-1 text-xs ${view === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              title="Table view with anchor text"
            >
              <TableIcon className="h-3 w-3" /> Table
            </button>
          </div>
          {/* Counts used for legend / a11y */}
          <span className="sr-only">{inboundCount + outboundCount} existing neighbors loaded</span>
        </div>
      </div>
      {view === "table" ? (
        <NeighborTables
          neighbors={visibleNeighbors}
          filter={filter}
          onSelectUrl={onSelectUrl}
        />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] flex-1 min-h-0">
        <div className="relative min-h-[300px] border-r">
          <svg ref={svgRef} className="w-full h-full" />
        </div>
        <div className="overflow-y-auto p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1 px-1">
            Neighbors ranked by score ({visibleNeighbors.length}
            {filter !== "all" ? ` of ${neighbors.length}` : ""})
          </div>
          {visibleNeighbors.length === 0 && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              {filter === "all" ? "No neighbors found." : `No ${filter} links.`}
            </div>
          )}
          {visibleNeighbors.map((nb) => (
            <div
              key={`${nb.direction}-${nb.url}`}
              className="w-full text-left rounded border border-border/60 hover:border-primary/60 hover:bg-muted/30 p-2.5 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div
                  className="text-xs px-2 py-0.5 rounded font-medium text-white"
                  style={{ background: DIR_COLOR[nb.direction] }}
                >
                  {DIR_LABEL[nb.direction]}
                </div>
                <div className="text-sm font-mono font-bold">
                  {(nb.totalScore * 100).toFixed(0)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelectUrl(nb.url)}
                className="text-xs font-mono truncate text-foreground hover:text-primary hover:underline block w-full text-left"
                title={`Focus the map on ${nb.url}`}
              >
                {nb.url}
              </button>
              <div className="flex items-center gap-2 mt-0.5">
                {nb.title && (
                  <div className="text-xs text-muted-foreground truncate flex-1">{nb.title}</div>
                )}
                <a
                  href={nb.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline shrink-0"
                  title={`Open ${nb.url} in a new tab`}
                  onClick={(e) => e.stopPropagation()}
                >
                  Open ↗
                </a>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <ScoreBar label="Relevance" value={nb.relevanceScore} color="#0554F2" />
                <ScoreBar label="Popularity" value={nb.popularityScore} color="#16a34a" />
                <ScoreBar label="Prominence" value={nb.prominenceScore} color="#7c3aed" />
              </div>
              {nb.anchorTexts.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {nb.anchorTexts.map((a, i) => (
                    <span key={i} className="text-[10px] bg-secondary px-1.5 py-0.5 rounded">
                      {a}
                    </span>
                  ))}
                </div>
              )}
              {nb.direction === "recommended" && (
                <div className="flex items-center gap-1 text-xs text-amber-700 mt-2">
                  <ArrowRight className="h-3 w-3" /> Consider adding an internal link here
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}

interface NeighborTablesProps {
  neighbors: LinkGraphFocusNeighbor[];
  filter: NeighborFilter;
  onSelectUrl: (url: string) => void;
}

function NeighborTables({ neighbors, filter, onSelectUrl }: NeighborTablesProps) {
  const inbound = neighbors.filter((n) => n.direction === "inbound" || n.direction === "both");
  const outbound = neighbors.filter((n) => n.direction === "outbound" || n.direction === "both");
  const recommended = neighbors.filter((n) => n.direction === "recommended");
  const showInbound = filter === "all" || filter === "inbound";
  const showOutbound = filter === "all" || filter === "outbound";
  const showRecommended = filter === "all" || filter === "recommended";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      {showInbound && (
        <NeighborTable
          title="Inbound (in-text, same domain)"
          subtitle="Pages on this site that link to the focused URL via an editorial body link. Anchor text is what the linking page used."
          color={DIR_COLOR.inbound}
          rows={inbound}
          onSelectUrl={onSelectUrl}
          showRecommended={false}
        />
      )}
      {showOutbound && (
        <NeighborTable
          title="Outbound (in-text, same domain)"
          subtitle="Pages this URL links out to via an editorial body link. Anchor text is what this page used."
          color={DIR_COLOR.outbound}
          rows={outbound}
          onSelectUrl={onSelectUrl}
          showRecommended={false}
        />
      )}
      {showRecommended && (
        <NeighborTable
          title="Recommended (missing in-text links)"
          subtitle="Semantically related pages on this site you don't currently link to from the body. Consider adding an editorial link."
          color={DIR_COLOR.recommended}
          rows={recommended}
          onSelectUrl={onSelectUrl}
          showRecommended
        />
      )}
    </div>
  );
}

function NeighborTable({
  title, subtitle, color, rows, onSelectUrl, showRecommended,
}: {
  title: string;
  subtitle: string;
  color: string;
  rows: LinkGraphFocusNeighbor[];
  onSelectUrl: (url: string) => void;
  showRecommended: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      switch (sortKey) {
        case "url": av = a.url; bv = b.url; break;
        case "anchor": av = (a.anchorTexts[0] ?? "").toLowerCase(); bv = (b.anchorTexts[0] ?? "").toLowerCase(); break;
        case "relevance": av = a.relevanceScore; bv = b.relevanceScore; break;
        case "popularity": av = a.popularityScore; bv = b.popularityScore; break;
        case "prominence": av = a.prominenceScore; bv = b.prominenceScore; break;
        default: av = a.totalScore; bv = b.totalScore;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const n1 = Number(av), n2 = Number(bv);
      return sortDir === "asc" ? n1 - n2 : n2 - n1;
    });
    return arr;
  }, [rows, sortKey, sortDir]);
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  };
  const SortBtn = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={`inline-flex items-center gap-1 hover:text-foreground ${right ? "justify-end w-full" : ""} ${sortKey === k ? "text-foreground" : ""}`}
    >
      {children}
      <ArrowUpDown className="h-3 w-3 opacity-50" />
    </button>
  );
  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center gap-3 flex-wrap">
        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
        <div className="font-medium text-sm">{title}</div>
        <Badge variant="outline" className="text-[10px]">{rows.length}</Badge>
        <div className="text-xs text-muted-foreground basis-full">{subtitle}</div>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground italic">None.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground text-left bg-muted/10">
                <th className="py-2 px-3 font-medium w-8">#</th>
                <th className="py-2 px-3 font-medium"><SortBtn k="url">URL</SortBtn></th>
                <th className="py-2 px-3 font-medium"><SortBtn k="anchor">Anchor text</SortBtn></th>
                <th className="py-2 px-3 font-medium text-right"><SortBtn k="relevance" right>Relevance</SortBtn></th>
                <th className="py-2 px-3 font-medium text-right"><SortBtn k="popularity" right>Popularity</SortBtn></th>
                <th className="py-2 px-3 font-medium text-right"><SortBtn k="prominence" right>Prominence</SortBtn></th>
                <th className="py-2 px-3 font-medium text-right"><SortBtn k="score" right>Score</SortBtn></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((nb, i) => (
                <tr key={`${nb.direction}-${nb.url}`} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-muted-foreground align-top">{i + 1}</td>
                  <td className="py-2 px-3 align-top min-w-0">
                    <button
                      type="button"
                      onClick={() => onSelectUrl(nb.url)}
                      className="font-mono text-primary hover:underline text-left truncate block max-w-[28rem]"
                      title={`Focus the map on ${nb.url}`}
                    >
                      {nb.url}
                    </button>
                    {nb.title && (
                      <div className="text-[10px] text-muted-foreground truncate max-w-[28rem]">{nb.title}</div>
                    )}
                  </td>
                  <td className="py-2 px-3 align-top max-w-[20rem]">
                    {nb.anchorTexts.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {nb.anchorTexts.map((a, j) => (
                          <span key={j} className="bg-secondary px-1.5 py-0.5 rounded text-[10px]" title={a}>
                            {a}
                          </span>
                        ))}
                      </div>
                    ) : showRecommended ? (
                      <span className="text-[10px] text-amber-700 inline-flex items-center gap-1">
                        <ArrowRight className="h-3 w-3" /> No link yet — add one
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground italic">(no anchor text captured)</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono align-top">{(nb.relevanceScore * 100).toFixed(0)}</td>
                  <td className="py-2 px-3 text-right font-mono align-top">{(nb.popularityScore * 100).toFixed(0)}</td>
                  <td className="py-2 px-3 text-right font-mono align-top">{(nb.prominenceScore * 100).toFixed(0)}</td>
                  <td className="py-2 px-3 text-right font-mono font-semibold align-top">{(nb.totalScore * 100).toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>{pct.toFixed(0)}</span>
      </div>
      <div className="h-1.5 rounded bg-muted overflow-hidden">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
