import { useState } from "react";
import { Link } from "wouter";
import {
  useGetStructuralTargets,
  useSuggestStructuralLinks,
  getGetStructuralTargetsQueryKey,
  getListSuggestionsQueryKey,
  type StructuralTarget,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HowThisWorks } from "@/components/how-this-works";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { Unplug, Link2Off, Sparkles, ArrowRight, AlertTriangle } from "lucide-react";

type FilterKey = "all" | "orphans" | "deadends" | "both";

function StatCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: number;
  icon: typeof Unplug;
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

function matchesFilter(t: StructuralTarget, f: FilterKey): boolean {
  if (f === "all") return true;
  if (f === "both") return t.isOrphan && t.isDeadEnd;
  if (f === "orphans") return t.isOrphan;
  return t.isDeadEnd;
}

export default function StructuralFixes() {
  const { data, isLoading } = useGetStructuralTargets();
  const suggest = useSuggestStructuralLinks();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [busyUrl, setBusyUrl] = useState<string | null>(null);

  const items = (data?.items ?? []).filter((t) => matchesFilter(t, filter));

  const handleGenerate = (url: string) => {
    setBusyUrl(url);
    suggest.mutate(
      { data: { url } },
      {
        onSuccess: (res) => {
          if (res.skipped) {
            toast({
              title: "Nothing generated",
              description: res.reason ?? "This page was skipped.",
            });
          } else {
            toast({
              title:
                res.generated > 0
                  ? `${res.generated} suggestion${res.generated === 1 ? "" : "s"} generated`
                  : "No new suggestions",
              description:
                res.generated > 0
                  ? "Review and approve them in Semantic Links."
                  : "No eligible link partners passed the relevance + consistency checks.",
            });
          }
          qc.invalidateQueries({ queryKey: getGetStructuralTargetsQueryKey() });
          qc.invalidateQueries({ queryKey: getListSuggestionsQueryKey() });
        },
        onError: () =>
          toast({ title: "Generation failed", variant: "destructive" }),
        onSettled: () => setBusyUrl(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Structural Fixes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Orphans (no internal links pointing in) and dead-ends (no internal
          links pointing out) leak crawl budget and PageRank. Generate targeted,
          relevance-scored link suggestions to repair them.
        </p>
      </div>

      <HowThisWorks
        summary="Repair orphan and dead-end pages with targeted internal links."
        steps={[
          {
            title: "Pick a structurally broken page",
            body: "Orphans have zero in-body inbound links; dead-ends have zero in-body outbound links. Both waste internal link equity.",
          },
          {
            title: "Generate suggestions",
            body: "For an orphan we search every eligible page that could naturally link in to it; for a dead-end we search every page it could link out to. Each candidate is scored on embedding similarity, authority, anchor fit and freshness, then fact-checked by an LLM consistency gate.",
          },
          {
            title: "Review in Semantic Links",
            body: "Approved suggestions land in the shared Semantic Links inbox tagged 'structural-v1', where you can Approve / Reject and copy the HTML or Markdown anchor.",
          },
        ]}
        tips={[
          "A page must be crawled and embedded first. Pages without an embedding show a 'needs crawl/embed' badge and can't generate suggestions yet.",
          "Generation runs one page at a time to keep model usage bounded. Pairs that already exist as links or suggestions are never proposed twice.",
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard
              label="Orphans"
              value={data?.orphanCount ?? 0}
              icon={Unplug}
              hint="Pages with no in-body internal links pointing to them. Search engines struggle to discover and rank them."
            />
            <StatCard
              label="Dead-ends"
              value={data?.deadEndCount ?? 0}
              icon={Link2Off}
              hint="Pages with no in-body internal links pointing out. They trap PageRank instead of distributing it across the site."
            />
            <StatCard
              label="Both"
              value={data?.bothCount ?? 0}
              icon={AlertTriangle}
              hint="Pages that are simultaneously orphans and dead-ends — the most isolated pages on the site."
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="orphans">Orphans</TabsTrigger>
                <TabsTrigger value="deadends">Dead-ends</TabsTrigger>
                <TabsTrigger value="both">Both</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <CopyButton
                getText={() =>
                  rowsToTsv(
                    ["Page", "URL", "Type", "In", "Out", "PageRank"],
                    items.map((t) => [
                      t.title ?? "(untitled)",
                      t.url,
                      [t.isOrphan ? "Orphan" : "", t.isDeadEnd ? "Dead-end" : ""]
                        .filter(Boolean)
                        .join(" / "),
                      t.inboundCount,
                      t.outboundCount,
                      t.internalPagerank.toFixed(4),
                    ]),
                  )
                }
                disabled={items.length === 0}
              />
              <Link href="/suggestions">
                <Button variant="outline" size="sm" className="gap-1">
                  Review inbox <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>

          {items.length === 0 ? (
            <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
              No pages in this view.
            </div>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="text-right">PageRank</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((t) => {
                    const busy = busyUrl === t.url && suggest.isPending;
                    return (
                      <TableRow key={t.url}>
                        <TableCell className="max-w-[360px] align-top">
                          <div className="font-medium text-sm truncate" title={t.title ?? undefined}>
                            {t.title ?? "(untitled)"}
                          </div>
                          <a
                            href={t.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary hover:underline truncate block"
                            title={`Open: ${t.url}`}
                          >
                            {t.url}
                          </a>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-1">
                            {t.isOrphan && (
                              <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10">
                                <Unplug className="h-3 w-3" /> Orphan
                              </Badge>
                            )}
                            {t.isDeadEnd && (
                              <Badge variant="outline" className="gap-1 text-blue-700 dark:text-blue-400 border-blue-500/30 bg-blue-500/10">
                                <Link2Off className="h-3 w-3" /> Dead-end
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums text-sm">
                          {t.inboundCount}
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums text-sm">
                          {t.outboundCount}
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums text-xs text-muted-foreground">
                          {t.internalPagerank.toFixed(4)}
                        </TableCell>
                        <TableCell className="align-top">
                          {!t.hasEmbedding ? (
                            <Badge variant="outline" className="text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10">
                              needs crawl/embed
                            </Badge>
                          ) : t.pendingSuggestions > 0 ? (
                            <Link href="/suggestions">
                              <Badge variant="secondary" className="cursor-pointer">
                                {t.pendingSuggestions} pending
                              </Badge>
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">ready</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <Button
                            size="sm"
                            disabled={!t.hasEmbedding || suggest.isPending}
                            onClick={() => handleGenerate(t.url)}
                            className="gap-1"
                          >
                            {busy ? (
                              <Spinner className="h-3.5 w-3.5" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5" />
                            )}
                            Generate
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
