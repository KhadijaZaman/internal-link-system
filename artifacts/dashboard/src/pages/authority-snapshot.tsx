import { useGetAuthoritySnapshot, type DemandQuery } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HowThisWorks } from "@/components/how-this-works";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import {
  Compass,
  FileText,
  Sparkles,
  Unplug,
  Link2Off,
  Link2,
  Gauge,
  Target,
  TriangleAlert,
} from "lucide-react";

function StatCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: string | number;
  icon: typeof Compass;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            {label}
            <InfoTip>{hint}</InfoTip>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SimilarityBadge({ sim, threshold }: { sim: number; threshold: number }) {
  const onCore = sim >= threshold;
  return (
    <Badge
      variant="outline"
      className={
        onCore
          ? "tabular-nums text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
          : "tabular-nums text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
      }
    >
      {sim.toFixed(3)}
    </Badge>
  );
}

function DemandTable({
  rows,
  threshold,
  empty,
}: {
  rows: DemandQuery[];
  threshold: number;
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="border rounded-lg border-dashed p-8 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="border rounded-lg overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Query</TableHead>
            <TableHead className="text-right">Impressions</TableHead>
            <TableHead className="text-right">Similarity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((q) => (
            <TableRow key={q.query}>
              <TableCell className="text-sm max-w-[420px] truncate" title={q.query}>
                {q.query}
              </TableCell>
              <TableCell className="text-right tabular-nums text-sm">
                {q.impressions.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <SimilarityBadge sim={q.similarity} threshold={threshold} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AuthoritySnapshot() {
  const { data, isLoading, isError } = useGetAuthoritySnapshot();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Spinner />
        <p className="text-sm">
          Building snapshot — embedding top queries on first run can take a
          minute…
        </p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
        Failed to build the authority snapshot. Make sure the site has been
        crawled and embedded.
      </div>
    );
  }

  const { health, centralEntity, demand } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Site Authority</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A deterministic snapshot of what your site is topically about (its
          central entity), how healthy the internal link graph is, and how much
          of your search demand actually aligns with that core.
        </p>
      </div>

      <HowThisWorks
        summary="See your central entity and whether your search demand is on-topic."
        steps={[
          {
            title: "Central entity",
            body: "We take your highest-authority pages (by internal PageRank), drop author archives and excluded pages, and average their embeddings — weighted by PageRank — into a single 'centre of gravity' vector for the site.",
          },
          {
            title: "On-core vs off-core demand",
            body: "Each of your top queries by impressions is embedded and compared (cosine similarity) to that central-entity vector. Queries at or above the threshold are on-core; the rest are off-core.",
          },
          {
            title: "Act on the gap",
            body: "High-impression off-core queries are where you're attracting traffic that doesn't match your core. Decide whether to build matching content, or accept it as a top-of-funnel lead magnet.",
          },
        ]}
        tips={[
          "Everything here is computed deterministically from embeddings — no LLM is involved, so the same data always yields the same snapshot.",
          "Brand and site: operator queries can look off-core because they're semantically opaque, not because they're off-topic.",
        ]}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          label="Content pages"
          value={health.totalPages.toLocaleString()}
          icon={FileText}
          hint={health.pageFilterLabel}
        />
        <StatCard
          label="Embedded"
          value={health.pagesWithEmbedding.toLocaleString()}
          icon={Sparkles}
          hint="Pages with an OpenAI embedding. Only embedded pages contribute to the central entity and similarity scoring."
        />
        <StatCard
          label="Orphans"
          value={health.orphanCount.toLocaleString()}
          icon={Unplug}
          hint="Pages with no in-body internal links pointing to them. Fix these in Structural Fixes."
        />
        <StatCard
          label="Dead-ends"
          value={health.deadEndCount.toLocaleString()}
          icon={Link2Off}
          hint="Pages with no in-body internal links pointing out. Fix these in Structural Fixes."
        />
        <StatCard
          label="Internal links"
          value={health.totalInternalLinks.toLocaleString()}
          icon={Link2}
          hint="Total in-body internal links across the site's link graph."
        />
        <StatCard
          label="Avg PageRank"
          value={health.avgInternalPagerank.toFixed(4)}
          icon={Gauge}
          hint="Mean internal PageRank across tracked pages — a reference scale for the anchor pages below."
        />
      </div>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <Compass className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                Central entity
                <InfoTip>
                  The dominant classified central-entity label among the
                  highest-authority pages, plus the pages that define the
                  centroid.
                </InfoTip>
              </div>
              <div className="text-xl font-semibold">
                {centralEntity.label ?? "Unclassified"}
              </div>
            </div>
          </div>
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              These {centralEntity.anchorPageCount} highest-authority pages define
              the centre of gravity for your site (PageRank-weighted).
            </p>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["Title", "URL", "In", "Tier", "PageRank"],
                  centralEntity.anchorPages.map((p) => [
                    p.title ?? "(untitled)",
                    p.url,
                    p.inboundCount,
                    p.tier ?? "—",
                    p.internalPagerank.toFixed(4),
                  ]),
                )
              }
              disabled={centralEntity.anchorPages.length === 0}
            />
          </div>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Anchor page</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Tier</TableHead>
                  <TableHead className="text-right">PageRank</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {centralEntity.anchorPages.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="max-w-[460px] align-top">
                      <div
                        className="font-medium text-sm truncate"
                        title={p.title ?? undefined}
                      >
                        {p.title ?? "(untitled)"}
                      </div>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-primary hover:underline truncate block"
                        title={`Open: ${p.url}`}
                      >
                        {p.url}
                      </a>
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums text-sm">
                      {p.inboundCount}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums text-sm text-muted-foreground">
                      {p.tier ?? "—"}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums text-xs text-muted-foreground">
                      {p.internalPagerank.toFixed(4)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-primary/10 p-2 text-primary">
                <Target className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm text-muted-foreground flex items-center gap-1">
                  Demand alignment
                  <InfoTip>
                    Top {demand.queriesAnalyzed} queries by impressions, split by
                    cosine similarity to the central entity.
                  </InfoTip>
                </div>
                <div className="text-xl font-semibold tabular-nums">
                  {demand.totalImpressions.toLocaleString()} impressions
                </div>
              </div>
            </div>
            <Badge variant="secondary" className="tabular-nums">
              Core threshold ≥ {data.threshold}
            </Badge>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <Target className="h-3.5 w-3.5" /> On-core{" "}
                <span className="tabular-nums">
                  {demand.onCore.impressionsPct}%
                </span>
                <span className="text-muted-foreground tabular-nums">
                  ({demand.onCore.queryCount} queries ·{" "}
                  {demand.onCore.impressions.toLocaleString()} impr)
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                <span className="text-muted-foreground tabular-nums">
                  ({demand.offCore.queryCount} queries ·{" "}
                  {demand.offCore.impressions.toLocaleString()} impr)
                </span>
                <span className="tabular-nums">
                  {demand.offCore.impressionsPct}%
                </span>{" "}
                Off-core <TriangleAlert className="h-3.5 w-3.5" />
              </span>
            </div>
            <Progress value={demand.onCore.impressionsPct} className="h-2.5" />
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="h-4 w-4" /> Worst off-core offenders
                  <InfoTip>
                    High-impression queries that diverge most from your central
                    entity. Either build aligned content or treat them as
                    top-of-funnel.
                  </InfoTip>
                </h3>
                <CopyButton
                  getText={() =>
                    rowsToTsv(
                      ["Query", "Impressions", "Similarity"],
                      demand.worstOffenders.map((q) => [
                        q.query,
                        q.impressions,
                        q.similarity.toFixed(3),
                      ]),
                    )
                  }
                  disabled={demand.worstOffenders.length === 0}
                />
              </div>
              <DemandTable
                rows={demand.worstOffenders}
                threshold={data.threshold}
                empty="No off-core demand detected."
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <Target className="h-4 w-4" /> Top on-core demand
                  <InfoTip>
                    Your highest-impression queries that align with the central
                    entity — the demand your core content is built to serve.
                  </InfoTip>
                </h3>
                <CopyButton
                  getText={() =>
                    rowsToTsv(
                      ["Query", "Impressions", "Similarity"],
                      demand.topOnCore.map((q) => [
                        q.query,
                        q.impressions,
                        q.similarity.toFixed(3),
                      ]),
                    )
                  }
                  disabled={demand.topOnCore.length === 0}
                />
              </div>
              <DemandTable
                rows={demand.topOnCore}
                threshold={data.threshold}
                empty="No on-core demand detected."
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
