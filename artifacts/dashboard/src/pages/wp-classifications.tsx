import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Treemap,
  Cell,
  LabelList,
} from "recharts";
import {
  useListWpClassifications,
  useUpdateWpClassification,
  useRunJob,
  getListWpClassificationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { HowThisWorks } from "@/components/how-this-works";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Play, RefreshCw, BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import type { WpClassification } from "@workspace/api-client-react";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

interface TreemapNodeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  root?: { children?: Array<{ name: string; tierKey: string }> };
  depth?: number;
  index?: number;
  tierColor: (k: string) => string;
}

function TierTreemapNode(props: TreemapNodeProps) {
  const { x = 0, y = 0, width = 0, height = 0, name, root, depth = 0, index = 0, tierColor } = props;
  if (depth === 0) return null;
  const parent = root?.children?.[index];
  const fill = parent ? tierColor(parent.tierKey) : "#9CA3AF";
  const showLabel = width > 60 && height > 24;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#fff" strokeWidth={2} fillOpacity={0.85} />
      {showLabel && (
        <text x={x + 6} y={y + 16} fill="#fff" fontSize={11} style={{ pointerEvents: "none" }}>
          {(name ?? "").length > Math.floor(width / 7) ? `${(name ?? "").slice(0, Math.floor(width / 7))}…` : name}
        </text>
      )}
    </g>
  );
}

function HealthTile({
  label,
  value,
  total,
  tone,
  hint,
}: {
  label: string;
  value: number;
  total: number;
  tone: "good" | "warn" | "neutral";
  hint: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const toneCls =
    tone === "good"
      ? "border-green-500/30 bg-green-500/5"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border/60 bg-card";
  const valueCls = tone === "good" ? "text-green-600" : tone === "warn" ? "text-amber-600" : "text-foreground";
  return (
    <div className={`rounded-md border p-3 ${toneCls}`}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {label}
        <InfoTip>{hint}</InfoTip>
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className={`text-2xl font-display ${valueCls}`}>{value}</span>
        <span className="text-xs text-muted-foreground font-mono">{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-1.5 h-1 bg-muted rounded overflow-hidden">
        <div
          className={tone === "good" ? "bg-green-500 h-full" : tone === "warn" ? "bg-amber-500 h-full" : "bg-primary h-full"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function WpClassifications() {
  const { data, isLoading, error } = useListWpClassifications();
  const qc = useQueryClient();
  const update = useUpdateWpClassification();
  const runJob = useRunJob();
  const { toast } = useToast();
  const [editing, setEditing] = useState<WpClassification | null>(null);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [vizOpen, setVizOpen] = useState(true);

  const allItems = data?.items ?? [];
  const items = allItems.filter((i) => {
    if (search && !i.url.toLowerCase().includes(search.toLowerCase())) return false;
    if (tierFilter !== "all" && String(i.tier ?? "") !== tierFilter) return false;
    return true;
  });

  const stats = useMemo(() => {
    const tierCounts: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, unknown: 0 };
    const subEntityByTier: Record<string, Record<string, number>> = {};
    let inBorders = 0;
    let outOfBorders = 0;
    let manuallyEdited = 0;
    let missingCanonical = 0;
    for (const i of allItems) {
      const tKey = i.tier ? String(i.tier) : "unknown";
      tierCounts[tKey] = (tierCounts[tKey] ?? 0) + 1;
      const sub = (i.subEntity ?? "Unassigned").trim() || "Unassigned";
      if (!subEntityByTier[tKey]) subEntityByTier[tKey] = {};
      subEntityByTier[tKey][sub] = (subEntityByTier[tKey][sub] ?? 0) + 1;
      if (i.topicalBordersMatch) inBorders++;
      else outOfBorders++;
      if (i.manuallyEdited) manuallyEdited++;
      if (!i.canonicalQuery) missingCanonical++;
    }
    const tierData = [
      { tier: "T1 root", key: "1", count: tierCounts["1"], fill: "#0554F2" },
      { tier: "T2 sub-pillar", key: "2", count: tierCounts["2"], fill: "#3B82F6" },
      { tier: "T3 cluster", key: "3", count: tierCounts["3"], fill: "#60A5FA" },
      { tier: "T4 outer leaf", key: "4", count: tierCounts["4"], fill: "#93C5FD" },
    ];
    if (tierCounts.unknown > 0) {
      tierData.push({ tier: "Unknown", key: "unknown", count: tierCounts.unknown, fill: "#D1D5DB" });
    }
    const treemap = Object.entries(subEntityByTier).map(([tier, subs]) => ({
      name: tier === "unknown" ? "Unknown" : `T${tier}`,
      tierKey: tier,
      children: Object.entries(subs)
        .map(([name, size]) => ({ name, size }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 20),
    }));
    return {
      tierData,
      treemap,
      inBorders,
      outOfBorders,
      manuallyEdited,
      missingCanonical,
      total: allItems.length,
    };
  }, [allItems]);

  const tierColor = (k: string): string => {
    const map: Record<string, string> = { "1": "#0554F2", "2": "#3B82F6", "3": "#60A5FA", "4": "#93C5FD", unknown: "#D1D5DB" };
    return map[k] ?? "#9CA3AF";
  };

  const handleRunCrawl = (job: "crawl_wordpress" | "reembed_wordpress") => {
    runJob.mutate(
      { jobName: job },
      {
        onSuccess: (r) => {
          toast({ title: r.message ?? "Started" });
        },
        onError: () => toast({ title: "Failed", variant: "destructive" }),
      },
    );
  };

  const handleSave = () => {
    if (!editing) return;
    update.mutate(
      {
        data: {
          url: editing.url,
          tier: editing.tier ?? null,
          centralEntity: editing.centralEntity ?? null,
          subEntity: editing.subEntity ?? null,
          parentRootUrl: editing.parentRootUrl ?? null,
          canonicalQuery: editing.canonicalQuery ?? null,
          anchorVariants: editing.anchorVariants ?? [],
          topicalBordersMatch: editing.topicalBordersMatch ?? true,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Saved" });
          setEditing(null);
          qc.invalidateQueries({ queryKey: getListWpClassificationsQueryKey() });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
            WP Classifications
            <InfoTip>Pages from your WordPress site organized into tiers (1 = root pillar, 4 = outer leaf). Tiers and canonical queries drive how the semantic linker chooses sources and targets.</InfoTip>
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Tier assignments and canonical queries from the WordPress crawler.
          </p>
          <div className="mt-3">
            <HowThisWorks
              summary="Every WordPress post and page is auto-classified into a tier (1 = root pillar, 4 = outer leaf) with a canonical query. Tiers drive how the semantic linker picks sources and targets."
              steps={[
                { title: "Crawler ingests WP", body: "Run WP crawl pulls every published post/page from the WordPress REST API and stores title, slug, body, and existing taxonomies." },
                { title: "Classification runs", body: "Each page is assigned a tier (1–4) and a canonical query based on its title, internal-link prominence, and topical role." },
                { title: "Edit assignments", body: "Click any row to override the tier or canonical query. Overrides are sticky — the next crawl won't touch them unless you reset." },
              ]}
              faqs={[
                { title: "How are tiers used?", body: "Tier 1 pages prefer to receive links from tier 2–4; tier 4 leaves prefer to link up to tier 1–2. The semantic linker uses tier distance to pick natural editorial pairs." },
                { title: "Why does canonical query matter?", body: "It's the primary entity the page is meant to rank for — used as the anchor target in proposals and as the focal point in optimizer briefs." },
              ]}
            />
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <InfoTip>Re-crawl the WordPress REST API to refresh content, tiers, and canonical queries for every published post and page.</InfoTip>
          <Button
            variant="outline"
            onClick={() => handleRunCrawl("crawl_wordpress")}
            disabled={runJob.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            Run WP crawl
          </Button>
          <InfoTip>Regenerate the OpenAI embeddings for every page. Use after major content updates or when changing the embedding model.</InfoTip>
          <Button
            variant="outline"
            onClick={() => handleRunCrawl("reembed_wordpress")}
            disabled={runJob.isPending}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Re-embed all
          </Button>
        </div>
      </div>

      {!isLoading && allItems.length > 0 && (
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              <button
                type="button"
                onClick={() => setVizOpen((v) => !v)}
                className="flex items-center gap-2 w-full text-left"
              >
                {vizOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <BarChart3 className="h-4 w-4 text-primary" />
                Site architecture overview
                <InfoTip>
                  Visual summary of the {allItems.length} crawled pages — tier distribution, sub-entity breakdown, and topical-borders health.
                </InfoTip>
                <span className="ml-auto text-xs text-muted-foreground font-normal">
                  {stats.total} pages · {stats.outOfBorders} out of borders · {stats.missingCanonical} missing canonical query · {stats.manuallyEdited} edited
                </span>
              </button>
            </CardTitle>
          </CardHeader>
          {vizOpen && (
            <CardContent className="space-y-6">
              {/* Tier distribution */}
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  Tier distribution
                  <InfoTip>How many pages fall into each tier. A healthy site has a small T1 root, a wider T2 layer, and a long T3/T4 tail. Click a bar to filter the table below.</InfoTip>
                </div>
                <div style={{ width: "100%", height: 180 }}>
                  <ResponsiveContainer>
                    <BarChart data={stats.tierData} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                      <XAxis dataKey="tier" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip
                        cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                        contentStyle={{ fontSize: 12, borderRadius: 6 }}
                        formatter={(v: number) => [`${v} pages`, "Count"]}
                      />
                      <Bar
                        dataKey="count"
                        radius={[6, 6, 0, 0]}
                        cursor="pointer"
                        onClick={(d: { key?: string }) => {
                          if (d?.key && d.key !== "unknown") setTierFilter(d.key);
                        }}
                      >
                        {stats.tierData.map((d) => (
                          <Cell key={d.key} fill={d.fill} fillOpacity={tierFilter === "all" || tierFilter === d.key ? 1 : 0.35} />
                        ))}
                        <LabelList dataKey="count" position="top" style={{ fontSize: 11, fill: "currentColor" }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Sub-entity treemap */}
                <div className="lg:col-span-2">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                    Sub-entities by tier (top 20 each)
                    <InfoTip>The biggest semantic clusters in the site. Block size = page count. Colors are tiers so you can see at a glance which entities live near the root vs the leaves.</InfoTip>
                  </div>
                  <div style={{ width: "100%", height: 320 }}>
                    <ResponsiveContainer>
                      <Treemap
                        data={stats.treemap}
                        dataKey="size"
                        stroke="#fff"
                        content={<TierTreemapNode tierColor={tierColor} />}
                      />
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Health tiles */}
                <div className="space-y-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                    Health
                    <InfoTip>Quick quality signals from the latest crawl + classification pass.</InfoTip>
                  </div>
                  <HealthTile
                    label="In topical borders"
                    value={stats.inBorders}
                    total={stats.total}
                    tone="good"
                    hint="Pages whose central entity sits inside the site's defined topical borders. These are safe to link aggressively."
                  />
                  <HealthTile
                    label="Out of borders"
                    value={stats.outOfBorders}
                    total={stats.total}
                    tone={stats.outOfBorders === 0 ? "good" : "warn"}
                    hint="Pages flagged as outside the site's topical borders. Review whether they belong on the site, or expand the borders to include them."
                  />
                  <HealthTile
                    label="Missing canonical query"
                    value={stats.missingCanonical}
                    total={stats.total}
                    tone={stats.missingCanonical === 0 ? "good" : "warn"}
                    hint="Pages without a canonical query. The semantic linker can't choose anchors for these — re-run the WP crawl or edit them manually."
                  />
                  <HealthTile
                    label="Manually edited"
                    value={stats.manuallyEdited}
                    total={stats.total}
                    tone="neutral"
                    hint="Pages whose tier or canonical query was set by hand. These won't be overwritten by future crawls."
                  />
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              Pages ({items.length})
              <InfoTip>Every crawled WordPress page. Click Edit to override the auto-assigned tier, sub-entity, canonical query, or anchor variants.</InfoTip>
            </span>
            <div className="flex gap-2 items-center">
              <Input
                placeholder="Filter URL..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
              <Select value={tierFilter} onValueChange={setTierFilter}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tiers</SelectItem>
                  <SelectItem value="1">Tier 1</SelectItem>
                  <SelectItem value="2">Tier 2</SelectItem>
                  <SelectItem value="3">Tier 3</SelectItem>
                  <SelectItem value="4">Tier 4</SelectItem>
                </SelectContent>
              </Select>
              <CopyButton
                getText={() =>
                  rowsToTsv(
                    ["Tier", "URL", "Title", "Canonical Query", "Sub-entity", "Quota Min", "Quota Max"],
                    items.map((i) => [
                      `T${i.tier ?? "?"}`,
                      i.url,
                      i.title ?? "",
                      i.canonicalQuery ?? "",
                      i.subEntity ?? "",
                      i.linkQuotaMin ?? 0,
                      i.linkQuotaMax ?? 0,
                    ]),
                  )
                }
                disabled={items.length === 0}
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : error ? (
            <div className="text-destructive py-12 text-center">Failed to load classifications</div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center">
              No classifications yet. Run the WP crawl to populate.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Canonical Query</TableHead>
                  <TableHead>Sub-entity</TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Quota
                      <InfoTip>
                        Target range of internal links this page should carry, derived from its word count using a
                        2–4 links per 1,000 words corridor (Koray Tuğberk Güğür's SOP). The <strong>semantic linker</strong>
                        uses Min as a soft floor — donors below it get a score boost so under-linked pages fill up first.
                        Max is reference for editorial trimming. (The over-linked audit currently uses its own fixed
                        thresholds, not this per-page max.)
                      </InfoTip>
                    </span>
                  </TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.url}>
                    <TableCell>
                      <Badge variant={i.tier === 1 ? "default" : i.tier === 2 ? "secondary" : "outline"}>
                        T{i.tier ?? "?"}
                      </Badge>
                      {i.manuallyEdited ? (
                        <span className="ml-2 text-xs text-muted-foreground">edited</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-xs truncate">{i.url}</TableCell>
                    <TableCell className="max-w-xs truncate">{i.title ?? "-"}</TableCell>
                    <TableCell className="max-w-xs truncate">{i.canonicalQuery ?? "-"}</TableCell>
                    <TableCell className="max-w-[10rem] truncate">{i.subEntity ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {i.linkQuotaMin ?? 0}–{i.linkQuotaMax ?? 0}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1">
                        <InfoTip>Manually adjust this page's tier, canonical query, sub-entity, or anchor variants. Edits override the AI classifier.</InfoTip>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                          Edit
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{editing?.url}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Tier</label>
                  <Select
                    value={String(editing.tier ?? "")}
                    onValueChange={(v) => setEditing({ ...editing, tier: Number(v) })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Tier 1 (root)</SelectItem>
                      <SelectItem value="2">Tier 2 (sub-pillar)</SelectItem>
                      <SelectItem value="3">Tier 3 (cluster)</SelectItem>
                      <SelectItem value="4">Tier 4 (outer)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Topical borders match</label>
                  <Select
                    value={editing.topicalBordersMatch ? "yes" : "no"}
                    onValueChange={(v) =>
                      setEditing({ ...editing, topicalBordersMatch: v === "yes" })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">In borders</SelectItem>
                      <SelectItem value="no">Out of borders</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Central entity</label>
                <Input
                  value={editing.centralEntity ?? ""}
                  onChange={(e) => setEditing({ ...editing, centralEntity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Sub-entity</label>
                <Input
                  value={editing.subEntity ?? ""}
                  onChange={(e) => setEditing({ ...editing, subEntity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Parent root URL</label>
                <Input
                  value={editing.parentRootUrl ?? ""}
                  onChange={(e) => setEditing({ ...editing, parentRootUrl: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Canonical query</label>
                <Input
                  value={editing.canonicalQuery ?? ""}
                  onChange={(e) => setEditing({ ...editing, canonicalQuery: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Anchor variants (one per line)</label>
                <textarea
                  className="w-full border rounded p-2 text-sm font-mono min-h-[100px] bg-background"
                  value={(editing.anchorVariants ?? []).join("\n")}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      anchorVariants: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={update.isPending}>
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
