import { useState, useRef, useEffect, useMemo } from "react";
import {
  useListTopicalMapRuns,
  getListTopicalMapRunsQueryKey,
  useGetTopicalMapRun,
  getGetTopicalMapRunQueryKey,
  useGenerateTopicalMap,
  useUpdateTopicalMapNode,
  type TopicalMapSummary,
  type TopicalMapNode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  EyeOff,
  Map as MapIcon,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { HowThisWorks } from "@/components/how-this-works";
import { JobSpendCapNotice } from "@/components/spend-cap-badge";
import { InfoTip } from "@/components/info-tip";
import * as d3 from "d3";

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

export default function TopicalMapPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    Record<TopicalMapNode["status"], boolean>
  >({ published: true, gap: true, ignored: true });
  const [showBridges, setShowBridges] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

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
        return rows.some((r) => r.status === "queued" || r.status === "running")
          ? 3000
          : false;
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

  // ---- Canvas rendering ----
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const hoverRef = useRef<number | null>(null);
  const selectedNodeRef = useRef<number | null>(null);
  const statusFilterRef = useRef(statusFilter);
  const showBridgesRef = useRef(showBridges);
  const drawRef = useRef<() => void>(() => {});

  selectedNodeRef.current = selectedNodeId;
  statusFilterRef.current = statusFilter;
  showBridgesRef.current = showBridges;

  useEffect(() => {
    drawRef.current();
  }, [selectedNodeId, statusFilter, showBridges]);

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
      const showBr = showBridgesRef.current;

      // Tree edges
      ctx.setLineDash([]);
      for (const e of edges) {
        if (!filt[e.to.status]) continue;
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

      // Nodes (hidden statuses stay as faint ghosts so the tree shape is readable)
      for (const n of nodes) {
        const hidden = !filt[n.status];
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
        if (!filt[n.status]) continue;
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

    const findNode = (mx: number, my: number): LaidOutNode | undefined => {
      const t = transformRef.current;
      const filt = statusFilterRef.current;
      const [x, y] = t.invert([mx, my]);
      let best: LaidOutNode | undefined;
      let bestDist = Infinity;
      for (const n of nodes) {
        if (!filt[n.status]) continue;
        const dist = Math.hypot(n.x - x, n.y - y);
        if (dist <= n.r + 6 / t.k && dist < bestDist) {
          best = n;
          bestDist = dist;
        }
      }
      return best;
    };

    const onClick = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      setSelectedNodeId(n ? n.id : null);
    };
    const onMove = (ev: MouseEvent) => {
      const [mx, my] = d3.pointer(ev, canvas);
      const n = findNode(mx, my);
      const next = n?.id ?? null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        canvas.style.cursor = next !== null ? "pointer" : "grab";
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

  const coverage = detail?.coverage ?? null;

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
            </CardHeader>
            <CardContent>
              <div ref={containerRef} className="relative w-full">
                <canvas ref={canvasRef} className="rounded-md border bg-white cursor-grab" />
              </div>
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
                    <button
                      key={n.id}
                      className="w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedNodeId(n.id)}
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
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </button>
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
