import { useState, useRef, useEffect, useMemo } from "react";
import {
  useListTopicalMapRuns,
  getListTopicalMapRunsQueryKey,
  useGetTopicalMapRun,
  getGetTopicalMapRunQueryKey,
  useGenerateTopicalMap,
  useUpdateTopicalMapNode,
  useAnalyzeTopicalMapCompetitors,
  type TopicalMapSummary,
  type TopicalMapNode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { rowsToTsv, tsvToCsv, copyToClipboard, type Cell } from "@/lib/clipboard";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Download,
  EyeOff,
  Globe,
  Map as MapIcon,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { HowThisWorks } from "@/components/how-this-works";
import { JobSpendCapNotice } from "@/components/spend-cap-badge";
import { InfoTip } from "@/components/info-tip";
import { DataNarrative, Num } from "@/components/data-narrative";
import * as d3 from "d3";
import { hitTestNodes, resolveClickSelection, resolveHoverTransition } from "@/lib/map-hittest";

const STATUS_COLOR: Record<TopicalMapNode["status"], string> = {
  published: "#10b981",
  gap: "#f59e0b",
  ignored: "#94a3b8",
};

const LEVEL_RADIUS: Record<TopicalMapNode["level"], number> = {
  pillar: 10,
  core_topic: 7,
  supporting: 5,
  subtopic: 3.5,
};

const STATUS_BADGE: Record<TopicalMapNode["status"], string> = {
  published: "bg-emerald-100 text-emerald-800 border-emerald-200",
  gap: "bg-amber-100 text-amber-800 border-amber-200",
  ignored: "bg-slate-100 text-slate-600 border-slate-200",
};

function runLabel(r: TopicalMapSummary): string {
  const date = new Date(r.createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} — ${r.centralEntity}`;
}

function phaseLabel(r: TopicalMapSummary): string {
  if (r.status === "queued") return "Queued — starting generation…";
  switch (r.phase) {
    case "skeleton":
      return "Designing the map skeleton (pillars & sections)…";
    case "expanding":
      return `Expanding pillars into topics… ${r.progressDone} of ${r.progressTotal}`;
    case "matching":
      return "Matching topics against your existing pages…";
    default:
      return "Generating…";
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

type LaidOutNode = TopicalMapNode & { x: number; y: number; r: number };

/** Compose a ready-made editorial brief for the content writer from a map node. */
function writerNotesFor(node: TopicalMapNode): string {
  const lines = [
    `From the Topical Authority Map — gap topic "${node.title}".`,
    `Suggested title: ${node.suggestedTitle}`,
    `Angle to own: ${node.attributeOwned}`,
  ];
  if (node.informationGain) lines.push(`Information gain angle: ${node.informationGain}`);
  lines.push(
    `Search intent: ${node.intent} (${node.predicate}) · funnel stage: ${node.funnelStage} · page type: ${node.pageType}`,
  );
  return lines.join("\n");
}

export default function TopicalMapPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    Record<TopicalMapNode["status"], boolean>
  >({ published: true, gap: true, ignored: true });
  const [priorityFilter, setPriorityFilter] = useState<
    Record<"high" | "medium" | "low", boolean>
  >({ high: true, medium: true, low: true });
  const [showBridges, setShowBridges] = useState(true);
  const [viewMode, setViewMode] = useState<"map" | "table">("map");
  const [formOpen, setFormOpen] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [topicSearch, setTopicSearch] = useState("");
  const [copiedExport, setCopiedExport] = useState(false);

  const sendToWriter = (node: TopicalMapNode) => {
    const params = new URLSearchParams({
      keyword: node.canonicalQuery,
      notes: writerNotesFor(node),
    });
    navigate(`/content/writer?${params.toString()}`);
  };

  const EXPORT_HEADERS = [
    "Topic",
    "Level",
    "Section",
    "Status",
    "Priority",
    "Funnel",
    "Canonical Query",
    "Matched Page",
    "GSC Clicks",
    "Competitor Domains",
  ];

  function buildExportRows(): Cell[][] {
    return orderedRows.filter(({ node }) => statusFilter[node.status] && priorityFilter[node.priority as "high" | "medium" | "low"]).map(({ node }) => [
      node.title,
      node.level.replace("_", " "),
      node.section,
      node.status === "published" ? "covered" : node.status === "gap" ? "gap" : "dismissed",
      node.priority,
      node.funnelStage,
      node.canonicalQuery,
      node.matchedPagePath ?? "",
      node.gscClicks ?? "",
      (node.competitors ?? []).map((c) => c.domain).join(", "),
    ]);
  }

  function downloadTableCsv() {
    if (!detail) return;
    const tsv = rowsToTsv(EXPORT_HEADERS, buildExportRows());
    const csv = tsvToCsv(tsv);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `topical-map-${detail.map.centralEntity.replace(/\s+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyTableForSheets() {
    if (!detail) return;
    const tsv = rowsToTsv(EXPORT_HEADERS, buildExportRows());
    const ok = await copyToClipboard(tsv);
    if (ok) {
      setCopiedExport(true);
      setTimeout(() => setCopiedExport(false), 2000);
    } else {
      toast({ title: "Copy failed", description: "Could not access the clipboard.", variant: "destructive" });
    }
  }

  const [centralEntity, setCentralEntity] = useState("");
  const [synonyms, setSynonyms] = useState("");
  const [searchIntent, setSearchIntent] = useState("");
  const [sourceContext, setSourceContext] = useState("");
  const [bordersWill, setBordersWill] = useState("");
  const [bordersWillNot, setBordersWillNot] = useState("");

  const runsQ = useListTopicalMapRuns({
    query: {
      queryKey: getListTopicalMapRunsQueryKey(),
      refetchInterval: (query) => {
        const rows = query.state.data ?? [];
        const mapGenerating = rows.some((r) => r.status === "queued" || r.status === "running");
        const scanRunning = rows.some(
          (r) => r.competitorScanStatus === "queued" || r.competitorScanStatus === "running",
        );
        return mapGenerating || scanRunning ? 3000 : false;
      },
    },
  });
  const runs = runsQ.data ?? [];
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "running");
  const completeRuns = runs.filter((r) => r.status === "complete");
  const failedLatest =
    !activeRun && runs.length > 0 && runs[0]!.status !== "complete" ? runs[0] : null;
  const selectedRun =
    completeRuns.find((r) => r.id === selectedRunId) ?? completeRuns[0] ?? null;

  // Prefill the charter form once from the most recent run.
  useEffect(() => {
    if (prefilled || runsQ.isLoading) return;
    const last = runs[0];
    if (last) {
      setCentralEntity(last.centralEntity);
      setSynonyms(last.entitySynonyms.join(", "));
      setSearchIntent(last.centralSearchIntent);
      setSourceContext(last.sourceContext);
      setBordersWill(last.bordersWill.join("\n"));
      setBordersWillNot(last.bordersWillNot.join("\n"));
    } else {
      setFormOpen(true);
    }
    setPrefilled(true);
  }, [prefilled, runsQ.isLoading, runs]);

  const generateMutation = useGenerateTopicalMap({
    mutation: {
      onSuccess: () => {
        setSelectedRunId(null);
        setSelectedNodeId(null);
        setStatusFilter({ published: true, gap: true, ignored: true });
        setPriorityFilter({ high: true, medium: true, low: true });
        setFormOpen(false);
        void queryClient.invalidateQueries({ queryKey: getListTopicalMapRunsQueryKey() });
      },
      onError: (err: unknown) => {
        const message =
          err && typeof err === "object" && "error" in err && typeof err.error === "string"
            ? err.error
            : "Could not start map generation.";
        toast({ title: "Generation not started", description: message, variant: "destructive" });
      },
    },
  });

  const canGenerate =
    centralEntity.trim().length >= 2 &&
    searchIntent.trim().length >= 10 &&
    sourceContext.trim().length >= 20 &&
    !activeRun;

  const startGeneration = () => {
    generateMutation.mutate({
      data: {
        sourceContext: sourceContext.trim(),
        centralEntity: centralEntity.trim(),
        entitySynonyms: synonyms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20),
        centralSearchIntent: searchIntent.trim(),
        bordersWill: splitLines(bordersWill).slice(0, 40),
        bordersWillNot: splitLines(bordersWillNot).slice(0, 40),
      },
    });
  };

  const detailQ = useGetTopicalMapRun(selectedRun?.id ?? 0, {
    query: {
      queryKey: getGetTopicalMapRunQueryKey(selectedRun?.id ?? 0),
      enabled: selectedRun !== null,
      staleTime: Infinity,
    },
  });
  const detail = detailQ.data ?? null;

  const scanMutation = useAnalyzeTopicalMapCompetitors({
    mutation: {
      onSuccess: (data) => {
        void queryClient.invalidateQueries({ queryKey: getListTopicalMapRunsQueryKey() });
        if (selectedRun) {
          void queryClient.invalidateQueries({
            queryKey: getGetTopicalMapRunQueryKey(selectedRun.id),
          });
        }
        // The job runs async; show the user the scan has been queued.
        toast({
          title: "Competitor scan started",
          description: `Fetching live SERP data for ${data.centralEntity} topics — this takes a few minutes.`,
        });
      },
      onError: (err: unknown) => {
        const message =
          err && typeof err === "object" && "error" in err && typeof err.error === "string"
            ? err.error
            : "Could not start competitor scan.";
        toast({ title: "Scan not started", description: message, variant: "destructive" });
      },
    },
  });

  // When the scan finishes (status transitions out of running/queued), refresh
  // the detail so competitor chips populate immediately.
  const prevScanStatus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const current = selectedRun?.competitorScanStatus ?? null;
    const prev = prevScanStatus.current;
    if (
      prev !== undefined &&
      (prev === "running" || prev === "queued") &&
      current !== "running" &&
      current !== "queued" &&
      selectedRun
    ) {
      void queryClient.invalidateQueries({
        queryKey: getGetTopicalMapRunQueryKey(selectedRun.id),
      });
    }
    prevScanStatus.current = current;
  }, [selectedRun?.competitorScanStatus, selectedRun, queryClient]);

  const updateNodeMutation = useUpdateTopicalMapNode({
    mutation: {
      onSuccess: () => {
        if (selectedRun) {
          void queryClient.invalidateQueries({
            queryKey: getGetTopicalMapRunQueryKey(selectedRun.id),
          });
        }
      },
      onError: () => {
        toast({
          title: "Update failed",
          description: "Could not update the topic status.",
          variant: "destructive",
        });
      },
    },
  });

  // ---- Radial tree layout (static, no simulation) ----
  const layout = useMemo(() => {
    if (!detail) return null;
    type TreeDatum = { node: TopicalMapNode | null; children: TreeDatum[] };
    const childrenOf = new Map<number, TopicalMapNode[]>();
    const roots: TopicalMapNode[] = [];
    const sorted = [...detail.nodes].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
    );
    for (const n of sorted) {
      if (n.parentId === null) {
        roots.push(n);
      } else {
        const list = childrenOf.get(n.parentId);
        if (list) list.push(n);
        else childrenOf.set(n.parentId, [n]);
      }
    }
    const toDatum = (n: TopicalMapNode): TreeDatum => ({
      node: n,
      children: (childrenOf.get(n.id) ?? []).map(toDatum),
    });
    const rootDatum: TreeDatum = { node: null, children: roots.map(toDatum) };
    const hierarchy = d3.hierarchy(rootDatum, (d) => d.children);
    const radius = 300;
    d3
      .tree<TreeDatum>()
      .size([2 * Math.PI, radius])
      .separation((a, b) => ((a.parent === b.parent ? 1 : 2) / Math.max(a.depth, 1)))(
      hierarchy,
    );
    const nodes: LaidOutNode[] = [];
    const posById = new Map<number, { x: number; y: number }>();
    for (const d of hierarchy.descendants()) {
      if (!d.data.node || d.x === undefined || d.y === undefined) continue;
      const angle = d.x - Math.PI / 2;
      const x = Math.cos(angle) * d.y;
      const y = Math.sin(angle) * d.y;
      const n = d.data.node;
      nodes.push({ ...n, x, y, r: LEVEL_RADIUS[n.level] });
      posById.set(n.id, { x, y });
    }
    const edges = nodes
      .filter((n) => n.parentId !== null)
      .map((n) => ({ from: posById.get(n.parentId!) ?? { x: 0, y: 0 }, to: n }));
    const rootEdges = nodes
      .filter((n) => n.parentId === null)
      .map((n) => ({ from: { x: 0, y: 0 }, to: n }));
    const bridges = detail.bridges
      .map((b) => ({
        from: posById.get(b.sourceNodeId),
        to: posById.get(b.targetNodeId),
        concept: b.bridgeConcept,
      }))
      .filter((b): b is { from: { x: number; y: number }; to: { x: number; y: number }; concept: string } =>
        Boolean(b.from && b.to),
      );
    return { nodes, edges: [...rootEdges, ...edges], bridges, centralEntity: detail.map.centralEntity };
  }, [detail]);

  const nodeById = useMemo(() => {
    const m = new Map<number, TopicalMapNode>();
    for (const n of detail?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [detail]);
  const selectedNode = selectedNodeId !== null ? (nodeById.get(selectedNodeId) ?? null) : null;

  const topicMatches = useMemo(() => {
    const q = topicSearch.trim().toLowerCase();
    if (q.length < 2 || !detail) return [];
    return detail.nodes
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.canonicalQuery.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [topicSearch, detail]);

  const jumpToNode = (id: number) => {
    setSelectedNodeId(id);
    setTopicSearch("");
    focusNodeRef.current(id);
  };

  // ---- Canvas rendering ----
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const hoverRef = useRef<number | null>(null);
  const selectedNodeRef = useRef<number | null>(null);
  const statusFilterRef = useRef(statusFilter);
  const priorityFilterRef = useRef(priorityFilter);
  const showBridgesRef = useRef(showBridges);
  const drawRef = useRef<() => void>(() => {});
  // Pans/zooms the canvas so the given node lands in the center (set up in the
  // canvas effect below; used by the topic search box and gap-list rows).
  const focusNodeRef = useRef<(id: number) => void>(() => {});

  selectedNodeRef.current = selectedNodeId;
  statusFilterRef.current = statusFilter;
  priorityFilterRef.current = priorityFilter;
  showBridgesRef.current = showBridges;

  useEffect(() => {
    drawRef.current();
  }, [selectedNodeId, statusFilter, priorityFilter, showBridges]);

  useEffect(() => {
    if (!layout || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = 640;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { nodes, edges, bridges, centralEntity: rootLabel } = layout;

    const draw = () => {
      const t = transformRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      const sel = selectedNodeRef.current;
      const hov = hoverRef.current;
      const filt = statusFilterRef.current;
      const priFilt = priorityFilterRef.current;
      const showBr = showBridgesRef.current;

      const isNodeVisible = (n: LaidOutNode) =>
        filt[n.status] && priFilt[n.priority as "high" | "medium" | "low"];

      // Tree edges
      ctx.setLineDash([]);
      for (const e of edges) {
        if (!isNodeVisible(e.to)) continue;
        ctx.beginPath();
        ctx.moveTo(e.from.x, e.from.y);
        ctx.lineTo(e.to.x, e.to.y);
        const touchesSel = sel !== null && e.to.id === sel;
        ctx.strokeStyle = touchesSel ? "#64748b" : "rgba(148, 163, 184, 0.4)";
        ctx.lineWidth = (touchesSel ? 1.6 : 0.8) / t.k;
        ctx.stroke();
      }

      // Bridges (dotted purple arcs)
      if (showBr) {
        ctx.setLineDash([5 / t.k, 4 / t.k]);
        for (const b of bridges) {
          ctx.beginPath();
          const mx = (b.from.x + b.to.x) / 2;
          const my = (b.from.y + b.to.y) / 2;
          // Bow the line toward the center so bridges read as cross-links.
          ctx.moveTo(b.from.x, b.from.y);
          ctx.quadraticCurveTo(mx * 0.35, my * 0.35, b.to.x, b.to.y);
          ctx.strokeStyle = "rgba(124, 58, 237, 0.5)";
          ctx.lineWidth = 1 / t.k;
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // Central entity
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();

      // Nodes (hidden statuses/priorities stay as faint ghosts so the tree shape is readable)
      for (const n of nodes) {
        const hidden = !isNodeVisible(n);
        const isSel = !hidden && n.id === sel;
        const isHov = !hidden && n.id === hov;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.globalAlpha = hidden ? 0.08 : n.status === "ignored" ? 0.55 : 1;
        ctx.fillStyle = STATUS_COLOR[n.status];
        ctx.fill();
        ctx.globalAlpha = 1;
        if (hidden) continue;
        if (n.section === "outer") {
          ctx.strokeStyle = "#475569";
          ctx.lineWidth = 1.2 / t.k;
          ctx.stroke();
        }
        if (isSel || isHov) {
          ctx.strokeStyle = isSel ? "#0f172a" : "#f59e0b";
          ctx.lineWidth = 2 / t.k;
          ctx.stroke();
        }
      }

      // Labels: central entity + pillars + core topics always; others when zoomed/hover/selected.
      ctx.fillStyle = "#334155";
      ctx.font = `${12 / t.k}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(rootLabel, 0, -20 / t.k);
      ctx.textAlign = "left";
      ctx.font = `${11 / t.k}px Inter, system-ui, sans-serif`;
      for (const n of nodes) {
        if (!isNodeVisible(n)) continue;
        const always = n.level === "pillar" || n.level === "core_topic";
        const zoomedIn = t.k >= 2.2;
        if (!always && !zoomedIn && n.id !== sel && n.id !== hov) continue;
        const short = n.title.length > 30 ? `${n.title.slice(0, 28)}…` : n.title;
        ctx.fillText(short, n.x + n.r + 3 / t.k, n.y + 3 / t.k);
      }
      ctx.restore();
    };
    drawRef.current = draw;

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.4, 8])
      .on("zoom", (ev) => {
        transformRef.current = ev.transform;
        draw();
      });
    const selCanvas = d3.select(canvas);
    selCanvas.call(zoom);
    // Start centered.
    selCanvas.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.85));

    focusNodeRef.current = (id: number) => {
      const n = nodes.find((node) => node.id === id);
      if (!n) return;
      const k = Math.max(transformRef.current.k, 2.4);
      const target = d3.zoomIdentity
        .translate(width / 2 - n.x * k, height / 2 - n.y * k)
        .scale(k);
      selCanvas
        .transition()
        .duration(450)
        .call(zoom.transform, target);
    };

    const findNode = (mx: number, my: number): LaidOutNode | undefined => {
      const t = transformRef.current;
      const [x, y] = t.invert([mx, my]);
      return hitTestNodes(
        x,
        y,
        t.k,
        nodes,
        statusFilterRef.current,
        priorityFilterRef.current,
      );
    };

    const onClick = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      setSelectedNodeId(resolveClickSelection(n));
    };
    const onMove = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      const { nextHoverId, didChange, cursor } = resolveHoverTransition(n, hoverRef.current);
      if (didChange) {
        hoverRef.current = nextHoverId;
        canvas.style.cursor = cursor;
        draw();
      }
    };
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("mousemove", onMove);
    draw();

    return () => {
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousemove", onMove);
      selCanvas.on(".zoom", null);
    };
  }, [layout]);

  // Depth-first order (pillar → its subtree) for the table view, so rows read
  // like an indented outline of the map.
  const orderedRows = useMemo(() => {
    if (!detail) return [];
    const childrenOf = new Map<number, TopicalMapNode[]>();
    const roots: TopicalMapNode[] = [];
    const sorted = [...detail.nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const n of sorted) {
      if (n.parentId === null) roots.push(n);
      else {
        const list = childrenOf.get(n.parentId);
        if (list) list.push(n);
        else childrenOf.set(n.parentId, [n]);
      }
    }
    const out: { node: TopicalMapNode; depth: number }[] = [];
    const walk = (n: TopicalMapNode, depth: number) => {
      out.push({ node: n, depth });
      for (const c of childrenOf.get(n.id) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
  }, [detail]);

  const coverage = detail?.coverage ?? null;

  const narrative = useMemo(() => {
    if (!detail || !coverage) return null;
    const gaps = detail.nodes.filter((n) => n.status === "gap");
    const highGaps = gaps.filter((n) => n.priority === "high");
    const rankedPillars = coverage.perPillar
      .filter((p) => p.total > 0)
      .sort((a, b) => a.coveragePct - b.coveragePct);
    const weakest = rankedPillars[0] ?? null;
    const strongest =
      rankedPillars.length > 1 ? rankedPillars[rankedPillars.length - 1]! : null;
    return { gaps, highGaps, weakest, strongest };
  }, [detail, coverage]);

  return (
    <div className="space-y-6" data-testid="page-topical-map">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MapIcon className="h-6 w-6" />
          Topical Authority Map
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate a Koray-style topical map from your business charter: pillars split into
          core and outer sections, expanded into topics, and matched against your existing
          pages to reveal coverage gaps.
        </p>
        <JobSpendCapNotice jobName="generate_topical_map" />
      </div>

      <HowThisWorks
        summary="An AI-built map of every topic your site should cover to become the go-to authority — showing what you've already written and what's still missing."
        steps={[
          {
            title: "Fill in the charter",
            body: "Tell the AI about your business: your main subject, what searchers want, and the topics you will and won't cover.",
          },
          {
            title: "Generate the map",
            body: "The AI designs a tree of topics (big themes broken down into sub-topics) and checks each one against pages you've already published.",
          },
          {
            title: "Read the colors",
            body: "Green dots are topics you already cover, amber dots are gaps you haven't written yet, and grey dots are ones you've dismissed.",
          },
          {
            title: "Work the gaps",
            body: "Open the Content gaps list and write the high-priority amber topics first to close the biggest holes in your coverage.",
          },
        ]}
        faqs={[
          {
            title: "What is a 'topical map'?",
            body: "A plan of all the related topics around your main subject. Covering them thoroughly signals to Google that you're an authority, which helps everything you publish rank better.",
          },
          {
            title: "What are pillars and bridges?",
            body: "Pillars are the big themes your site is built on. Bridges (dashed purple lines) connect related topics that sit under different pillars.",
          },
          {
            title: "What does 'coverage' mean?",
            body: "The share of mapped topics you've already published a page for. Higher coverage means fewer gaps left to fill.",
          },
          {
            title: "Can I hide topics I don't want?",
            body: "Yes — open a topic and choose Dismiss. It turns grey and stops counting as a gap. You can restore it later.",
          },
        ]}
        tips={[
          "Scroll to zoom and drag to pan the map; click any dot to see its brief.",
          "Start with high-priority gaps — they usually give the most impact for the least effort.",
          "Topics with a dark ring are 'outer section' — supporting content that rounds out a pillar.",
        ]}
      />

      <Collapsible open={formOpen} onOpenChange={setFormOpen}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="pb-3 cursor-pointer select-none">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Map charter</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${formOpen ? "rotate-180" : ""}`}
                />
              </CardTitle>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Central entity</label>
                  <Input
                    value={centralEntity}
                    onChange={(e) => setCentralEntity(e.target.value)}
                    placeholder="e.g. AI search visibility"
                    disabled={!!activeRun}
                    data-testid="input-central-entity"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Synonyms{" "}
                    <span className="text-muted-foreground font-normal">(comma-separated)</span>
                  </label>
                  <Input
                    value={synonyms}
                    onChange={(e) => setSynonyms(e.target.value)}
                    placeholder="e.g. AI SEO, generative engine optimization"
                    disabled={!!activeRun}
                    data-testid="input-synonyms"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Central search intent</label>
                <Textarea
                  value={searchIntent}
                  onChange={(e) => setSearchIntent(e.target.value)}
                  placeholder="One sentence with predicates — what searchers want to know, compare, and buy around the entity."
                  rows={2}
                  disabled={!!activeRun}
                  data-testid="input-search-intent"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Source context (business charter)</label>
                <Textarea
                  value={sourceContext}
                  onChange={(e) => setSourceContext(e.target.value)}
                  placeholder="One paragraph: who the business is, what it sells, and how content converts into revenue."
                  rows={4}
                  disabled={!!activeRun}
                  data-testid="input-source-context"
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Borders — will cover{" "}
                    <span className="text-muted-foreground font-normal">(one per line)</span>
                  </label>
                  <Textarea
                    value={bordersWill}
                    onChange={(e) => setBordersWill(e.target.value)}
                    rows={4}
                    disabled={!!activeRun}
                    data-testid="input-borders-will"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Borders — will NOT cover{" "}
                    <span className="text-muted-foreground font-normal">(one per line)</span>
                  </label>
                  <Textarea
                    value={bordersWillNot}
                    onChange={(e) => setBordersWillNot(e.target.value)}
                    rows={4}
                    disabled={!!activeRun}
                    data-testid="input-borders-will-not"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-xs text-muted-foreground">
                  Generation runs in the background and typically takes a few minutes.
                </span>
                <Button
                  onClick={startGeneration}
                  disabled={!canGenerate || generateMutation.isPending}
                  data-testid="button-generate-map"
                >
                  {generateMutation.isPending ? (
                    <Spinner className="h-4 w-4 mr-2" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  Generate map
                </Button>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {activeRun && (
        <Card data-testid="card-active-run">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              <span>{phaseLabel(activeRun)}</span>
            </div>
            <Progress
              value={
                activeRun.progressTotal > 0
                  ? (activeRun.progressDone / activeRun.progressTotal) * 100
                  : activeRun.phase === "matching"
                    ? 90
                    : 5
              }
            />
            <p className="text-xs text-muted-foreground">
              The map is designed pillar by pillar, then matched against your page inventory.
            </p>
          </CardContent>
        </Card>
      )}

      {failedLatest && (
        <Card className="border-destructive/50" data-testid="card-failed-run">
          <CardContent className="pt-6 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                Last generation{" "}
                {failedLatest.status === "interrupted" ? "was interrupted" : "failed"}
              </p>
              {failedLatest.error && (
                <p className="text-muted-foreground mt-1">{failedLatest.error}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {completeRuns.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Showing map:</span>
          <Select
            value={String(selectedRun?.id ?? "")}
            onValueChange={(v) => {
              setSelectedRunId(Number(v));
              setSelectedNodeId(null);
              setStatusFilter({ published: true, gap: true, ignored: true });
              setPriorityFilter({ high: true, medium: true, low: true });
            }}
          >
            <SelectTrigger className="w-[320px]" data-testid="select-run">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {completeRuns.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {runLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {coverage && detail && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card data-testid="card-coverage-overall">
            <CardContent className="pt-6">
              <p className="text-3xl font-semibold tabular-nums">{coverage.coveragePct}%</p>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                Topical coverage
                <InfoTip>
                  The share of mapped topics you've already published a page for. Higher is
                  better — it means fewer gaps left to fill.
                </InfoTip>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-semibold tabular-nums text-emerald-600">
                {coverage.publishedNodes}
              </p>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                Topics covered
                <InfoTip>
                  Green topics that already match a page on your site — nothing to do here.
                </InfoTip>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-semibold tabular-nums text-amber-600">
                {coverage.gapNodes}
              </p>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                Content gaps
                <InfoTip>
                  Amber topics with no page yet — these are what to write next to grow your
                  coverage.
                </InfoTip>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-semibold tabular-nums text-slate-500">
                {coverage.ignoredNodes}
              </p>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                Dismissed
                <InfoTip>
                  Topics you chose to skip. They turn grey and don't count toward your
                  coverage score.
                </InfoTip>
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {coverage && detail && narrative && (
        <DataNarrative
          paragraphs={[
            <>
              This map lays out <Num>{detail.nodes.length} topics</Num> your site should
              cover around "{detail.map.centralEntity}". You've already published pages
              for <Num>{coverage.publishedNodes}</Num> of them —{" "}
              <Num>{coverage.coveragePct}% coverage</Num> — leaving{" "}
              <Num>{narrative.gaps.length} gaps</Num> still to write
              {narrative.highGaps.length > 0 ? (
                <>
                  , including <Num>{narrative.highGaps.length} high-priority</Num> ones
                </>
              ) : null}
              .
            </>,
            ...(narrative.weakest
              ? [
                  <>
                    Your thinnest theme is <Num>"{narrative.weakest.title}"</Num> at{" "}
                    <Num>{narrative.weakest.coveragePct}%</Num> covered
                    {narrative.strongest &&
                    narrative.strongest.nodeId !== narrative.weakest.nodeId ? (
                      <>
                        , while <Num>"{narrative.strongest.title}"</Num> is your strongest
                        at <Num>{narrative.strongest.coveragePct}%</Num>
                      </>
                    ) : null}
                    . Filling the thin themes first sends the strongest authority signal.
                  </>,
                ]
              : []),
          ]}
          insights={[
            {
              tone: "warn" as const,
              text: (
                <>
                  Start with the high-priority gaps in the list below — each one has a
                  "Write" button that opens the Content Writer with the brief already
                  filled in.
                </>
              ),
            },
          ]}
        />
      )}

      {detail && layout && (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <Card data-testid="card-map-canvas">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-base flex items-center gap-1.5">
                  Map — {detail.map.centralEntity}
                  <InfoTip>
                    Each dot is a topic. The center is your main subject; dots branch out into
                    pillars (big themes) and their sub-topics. Color shows whether you've
                    covered it yet.
                  </InfoTip>
                </CardTitle>
                <div className="flex items-center gap-1.5 text-xs">
                  <div className="flex rounded-md border overflow-hidden mr-1">
                    {(["map", "table"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setViewMode(m)}
                        className={`px-2.5 py-1 transition-colors ${
                          viewMode === m
                            ? "bg-foreground text-background"
                            : "bg-background text-muted-foreground hover:bg-muted/60"
                        }`}
                        data-testid={`button-view-${m}`}
                      >
                        {m === "map" ? "Map" : "Table"}
                      </button>
                    ))}
                  </div>
                  {viewMode === "table" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs gap-1"
                        onClick={() => void copyTableForSheets()}
                        title="Copy as tab-separated values — paste straight into Google Sheets or Excel"
                        data-testid="button-copy-table-sheets"
                      >
                        {copiedExport ? (
                          <Check className="h-3 w-3 text-emerald-600" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedExport ? "Copied!" : "Copy for Sheets"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs gap-1"
                        onClick={downloadTableCsv}
                        title="Download as CSV"
                        data-testid="button-export-csv"
                      >
                        <Download className="h-3 w-3" />
                        Export CSV
                      </Button>
                    </>
                  )}
                  {(
                    [
                      { key: "published" as const, label: "Covered", dot: "bg-emerald-500" },
                      { key: "gap" as const, label: "Gap", dot: "bg-amber-500" },
                      { key: "ignored" as const, label: "Dismissed", dot: "bg-slate-400" },
                    ]
                  ).map(({ key, label, dot }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setStatusFilter((f) => ({ ...f, [key]: !f[key] }))
                      }
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                        statusFilter[key]
                          ? "border-border bg-muted/60 text-foreground"
                          : "border-transparent text-muted-foreground/50 line-through"
                      }`}
                      title={
                        statusFilter[key]
                          ? `Hide ${label.toLowerCase()} topics`
                          : `Show ${label.toLowerCase()} topics`
                      }
                      data-testid={`button-filter-${key}`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full inline-block ${dot} ${
                          statusFilter[key] ? "" : "opacity-30"
                        }`}
                      />
                      {label}
                    </button>
                  ))}
                  <span className="text-muted-foreground/40 mx-0.5">|</span>
                  {(
                    [
                      { key: "high" as const, label: "High", dot: "bg-rose-500" },
                      { key: "medium" as const, label: "Medium", dot: "bg-orange-400" },
                      { key: "low" as const, label: "Low", dot: "bg-sky-400" },
                    ]
                  ).map(({ key, label, dot }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setPriorityFilter((f) => ({ ...f, [key]: !f[key] }))
                      }
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                        priorityFilter[key]
                          ? "border-border bg-muted/60 text-foreground"
                          : "border-transparent text-muted-foreground/50 line-through"
                      }`}
                      title={
                        priorityFilter[key]
                          ? `Hide ${label.toLowerCase()}-priority topics`
                          : `Show ${label.toLowerCase()}-priority topics`
                      }
                      data-testid={`button-filter-priority-${key}`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full inline-block ${dot} ${
                          priorityFilter[key] ? "" : "opacity-30"
                        }`}
                      />
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowBridges((v) => !v)}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                      showBridges
                        ? "border-border bg-muted/60 text-foreground"
                        : "border-transparent text-muted-foreground/50 line-through"
                    }`}
                    title={showBridges ? "Hide bridge lines" : "Show bridge lines"}
                    data-testid="button-filter-bridges"
                  >
                    <span
                      className={`w-4 border-t border-dashed border-purple-500 inline-block ${
                        showBridges ? "" : "opacity-30"
                      }`}
                    />
                    Bridge
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Scroll to zoom, drag to pan, click a topic for details. Click a legend chip
                to show or hide those topics. Outer-section topics have a dark ring.
              </p>
              <div className="relative mt-1">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={topicSearch}
                  onChange={(e) => setTopicSearch(e.target.value)}
                  placeholder="Find a topic by name… (e.g. anchor text)"
                  className="h-8 pl-8 text-sm max-w-sm"
                  data-testid="input-topic-search"
                />
                {topicMatches.length > 0 && (
                  <div
                    className="absolute z-20 mt-1 w-full max-w-sm rounded-md border bg-popover shadow-md overflow-hidden"
                    data-testid="list-topic-search-results"
                  >
                    {topicMatches.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                        onClick={() => jumpToNode(n.id)}
                        data-testid={`topic-search-result-${n.id}`}
                      >
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: STATUS_COLOR[n.status] }}
                        />
                        <span className="truncate flex-1">{n.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {n.status === "published"
                            ? "covered"
                            : n.status === "gap"
                              ? "gap"
                              : "dismissed"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {topicSearch.trim().length >= 2 && topicMatches.length === 0 && (
                  <div className="absolute z-20 mt-1 w-full max-w-sm rounded-md border bg-popover shadow-md px-2.5 py-1.5 text-sm text-muted-foreground">
                    No topics match "{topicSearch.trim()}".
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {/* Keep the canvas mounted (hidden) so pan/zoom state survives view switches. */}
              <div ref={containerRef} className={viewMode === "map" ? "relative w-full" : "hidden"}>
                <canvas ref={canvasRef} className="rounded-md border bg-white cursor-grab" />
              </div>
              {viewMode === "table" && (
                <div className="max-h-[640px] overflow-auto rounded-md border" data-testid="table-topical-map">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <TableHead className="min-w-[260px]">Topic</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Priority</TableHead>
                        <TableHead>Funnel</TableHead>
                        <TableHead className="min-w-[180px]">Your page</TableHead>
                        <TableHead className="text-right">Clicks</TableHead>
                        <TableHead className="min-w-[280px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1">
                              Competitors ranking
                              <InfoTip>
                                Competitor domains already ranking on Google for this topic.
                                Click "Scan competitors" to fetch live SERP data for every
                                topic — this uses your DataForSEO budget (~$0.0006/topic).
                                Requires the DataForSEO account to have funds.
                              </InfoTip>
                            </span>
                            {selectedRun &&
                              (selectedRun.competitorScanStatus === "running" ||
                              selectedRun.competitorScanStatus === "queued" ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground font-normal">
                                  <Spinner className="h-3 w-3" />
                                  Scanning…
                                </span>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 font-normal"
                                  disabled={scanMutation.isPending}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    scanMutation.mutate({ mapId: selectedRun.id });
                                  }}
                                  data-testid="button-scan-competitors"
                                >
                                  <Globe className="h-3 w-3 mr-1" />
                                  Scan competitors
                                </Button>
                              ))}
                          </div>
                          {selectedRun?.competitorScanStatus === "failed" &&
                            selectedRun.competitorScanError && (
                              <p className="text-[11px] text-destructive mt-0.5 font-normal">
                                {selectedRun.competitorScanError.includes("out of funds") ||
                                selectedRun.competitorScanError.includes("402")
                                  ? "DataForSEO out of funds — top up at app.dataforseo.com"
                                  : selectedRun.competitorScanError}
                              </p>
                            )}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orderedRows
                        .filter(({ node }) => statusFilter[node.status] && priorityFilter[node.priority as "high" | "medium" | "low"])
                        .map(({ node, depth }) => (
                          <TableRow
                            key={node.id}
                            className={`cursor-pointer ${selectedNodeId === node.id ? "bg-muted/60" : ""}`}
                            onClick={() => setSelectedNodeId(node.id)}
                            data-testid={`row-topic-${node.id}`}
                          >
                            <TableCell className="py-2">
                              <div
                                className="flex items-center gap-2"
                                style={{ paddingLeft: `${depth * 16}px` }}
                              >
                                <span
                                  className="h-2.5 w-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: STATUS_COLOR[node.status] }}
                                />
                                <span className={depth === 0 ? "font-medium" : ""}>{node.title}</span>
                                {node.section === "outer" && (
                                  <Badge variant="outline" className="text-[10px] px-1 py-0">
                                    outer
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="py-2">
                              <Badge variant="outline" className={STATUS_BADGE[node.status]}>
                                {node.status === "published"
                                  ? "covered"
                                  : node.status === "gap"
                                    ? "gap"
                                    : "dismissed"}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-2 text-xs capitalize">{node.priority}</TableCell>
                            <TableCell className="py-2 text-xs uppercase">{node.funnelStage}</TableCell>
                            <TableCell className="py-2 text-xs">
                              {node.matchedPagePath ? (
                                <span className="text-emerald-700 break-all">{node.matchedPagePath}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="py-2 text-right text-xs tabular-nums">
                              {node.gscClicks ?? "—"}
                            </TableCell>
                            <TableCell className="py-2">
                              {node.competitors && node.competitors.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {node.competitors.map((c) => (
                                    <a
                                      key={c.domain}
                                      href={c.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] hover:bg-muted/60"
                                      title={`Ranks #${c.bestPosition ?? "?"} for "${c.matchedQuery}"`}
                                    >
                                      {c.domain}
                                      {c.bestPosition != null && (
                                        <span className="text-muted-foreground">#{c.bestPosition}</span>
                                      )}
                                    </a>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            {selectedNode ? (
              <Card data-testid="card-node-detail">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm leading-snug">{selectedNode.title}</CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setSelectedNodeId(null)}
                      data-testid="button-close-node"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Badge variant="outline" className={STATUS_BADGE[selectedNode.status]}>
                      {selectedNode.status === "published"
                        ? "Covered"
                        : selectedNode.status === "gap"
                          ? "Gap"
                          : "Dismissed"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {selectedNode.level.replace("_", " ")}
                    </Badge>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {selectedNode.section === "core" ? "core section" : "outer section"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {selectedNode.funnelStage}
                    </Badge>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {selectedNode.priority} priority
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      Canonical query
                      <InfoTip>
                        The main search phrase this page should aim to rank for.
                      </InfoTip>
                    </p>
                    <p>{selectedNode.canonicalQuery}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      Attribute owned
                      <InfoTip>
                        The specific angle or fact this page is meant to "own" so it stands out
                        from competitors covering the same topic.
                      </InfoTip>
                    </p>
                    <p>{selectedNode.attributeOwned}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Search intent</p>
                    <p>
                      {selectedNode.intent}{" "}
                      <span className="text-muted-foreground">({selectedNode.predicate})</span>
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Page type</p>
                    <p>{selectedNode.pageType}</p>
                  </div>
                  {selectedNode.informationGain && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        Information gain angle
                        <InfoTip>
                          Something new or unique this page can add that competing articles
                          don't already cover — a reason for it to exist.
                        </InfoTip>
                      </p>
                      <p>{selectedNode.informationGain}</p>
                    </div>
                  )}
                  {selectedNode.borderNote && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Border note</p>
                      <p>{selectedNode.borderNote}</p>
                    </div>
                  )}
                  {selectedNode.status === "published" && selectedNode.matchedPagePath ? (
                    <div className="rounded-md border bg-emerald-50/50 p-2.5 space-y-1">
                      <p className="text-xs font-medium text-emerald-800">Matched page</p>
                      <p className="text-xs font-mono break-all">
                        {selectedNode.matchedPagePath}
                      </p>
                      {selectedNode.pageTitle && (
                        <p className="text-xs text-muted-foreground">{selectedNode.pageTitle}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        via {selectedNode.matchSource?.replace("_", " ")}
                        {selectedNode.matchConfidence !== null
                          ? ` · ${(selectedNode.matchConfidence * 100).toFixed(0)}% confidence`
                          : ""}
                      </p>
                      {(selectedNode.gscClicks !== null ||
                        selectedNode.gscImpressions !== null) && (
                        <p className="text-xs text-muted-foreground">
                          {selectedNode.gscClicks ?? 0} clicks ·{" "}
                          {selectedNode.gscImpressions ?? 0} impressions
                          {selectedNode.gscPosition !== null
                            ? ` · pos ${selectedNode.gscPosition.toFixed(1)}`
                            : ""}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-md border bg-muted/40 p-2.5 space-y-2">
                      <p className="text-xs font-medium">Suggested page</p>
                      <p className="text-xs font-mono break-all">{selectedNode.suggestedSlug}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedNode.suggestedTitle}
                      </p>
                    </div>
                  )}
                  {selectedNode.status === "gap" && (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => sendToWriter(selectedNode)}
                      data-testid="button-send-to-writer"
                    >
                      <Sparkles className="h-3.5 w-3.5 mr-2" />
                      Write this article
                    </Button>
                  )}
                  {selectedNode.status !== "published" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={updateNodeMutation.isPending}
                      onClick={() =>
                        updateNodeMutation.mutate({
                          nodeId: selectedNode.id,
                          data: {
                            status: selectedNode.status === "gap" ? "ignored" : "gap",
                          },
                        })
                      }
                      data-testid="button-toggle-node-status"
                    >
                      {updateNodeMutation.isPending ? (
                        <Spinner className="h-3.5 w-3.5 mr-2" />
                      ) : selectedNode.status === "gap" ? (
                        <EyeOff className="h-3.5 w-3.5 mr-2" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5 mr-2" />
                      )}
                      {selectedNode.status === "gap" ? "Dismiss this topic" : "Restore as gap"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6 text-sm text-muted-foreground">
                  Click a topic on the map to see its brief: canonical query, owned
                  attribute, funnel stage, and the matched or suggested page.
                </CardContent>
              </Card>
            )}

            {coverage && (
              <Card data-testid="card-pillar-coverage">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    Coverage by pillar
                    <InfoTip>
                      How much of each big theme (pillar) you've covered so far. A short bar
                      means lots of gaps still to write in that theme.
                    </InfoTip>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {coverage.perPillar.map((p) => (
                    <div key={p.nodeId} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <button
                          className="truncate hover:underline text-left"
                          onClick={() => setSelectedNodeId(p.nodeId)}
                          title={p.title}
                        >
                          {p.title}
                          {p.section === "outer" && (
                            <span className="text-muted-foreground"> · outer</span>
                          )}
                        </button>
                        <span className="tabular-nums text-muted-foreground shrink-0">
                          {p.published}/{p.total} · {p.coveragePct}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${Math.min(p.coveragePct, 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {detail && (
        <Card data-testid="card-gap-list">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-1.5">
              Content gaps ({detail.nodes.filter((n) => n.status === "gap").length})
              <InfoTip>
                Mapped topics with no page yet, ordered by priority. Write these — starting at
                the top — to grow your coverage. Click any row to see its brief.
              </InfoTip>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Topics in the map with no matching page yet — sorted by priority.
            </p>
          </CardHeader>
          <CardContent>
            {detail.nodes.filter((n) => n.status === "gap").length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No gaps — every topic in the map is matched to an existing page.
              </p>
            ) : (
              <div className="space-y-1.5">
                {detail.nodes
                  .filter((n) => n.status === "gap")
                  .sort((a, b) => {
                    const rank = { high: 0, medium: 1, low: 2 } as const;
                    return rank[a.priority] - rank[b.priority] || a.sortOrder - b.sortOrder;
                  })
                  .map((n) => (
                    <div
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted/50 transition-colors cursor-pointer"
                      onClick={() => jumpToNode(n.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          jumpToNode(n.id);
                        }
                      }}
                      data-testid={`gap-row-${n.id}`}
                    >
                      <Badge
                        variant="outline"
                        className={
                          n.priority === "high"
                            ? "bg-rose-100 text-rose-800 border-rose-200 shrink-0"
                            : n.priority === "medium"
                              ? "bg-amber-100 text-amber-800 border-amber-200 shrink-0"
                              : "bg-slate-100 text-slate-600 border-slate-200 shrink-0"
                        }
                      >
                        {n.priority}
                      </Badge>
                      <span className="text-sm truncate flex-1">{n.title}</span>
                      <span className="text-xs text-muted-foreground font-mono truncate hidden md:block max-w-[280px]">
                        {n.suggestedSlug}
                      </span>
                      <Badge variant="secondary" className="text-xs font-normal shrink-0">
                        {n.funnelStage}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 h-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          sendToWriter(n);
                        }}
                        data-testid={`button-write-gap-${n.id}`}
                      >
                        <Sparkles className="h-3 w-3 mr-1.5" />
                        Write
                      </Button>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!selectedRun && !activeRun && !failedLatest && !runsQ.isLoading && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No topical maps yet. Fill in the charter above and click Generate map — the
            result is a full pillar/topic tree matched against your existing pages.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
