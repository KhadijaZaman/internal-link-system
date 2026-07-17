import { useMemo, useState } from "react";
import { useGetGscQueries } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { MetricCard } from "@/components/gsc/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortableHeader, type SortState } from "@/components/gsc/sortable-header";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

type Filter = "all" | "branded" | "unbranded";
type SortKey = "query" | "clicks" | "impressions" | "ctr" | "position";

function QueriesBody() {
  const { range } = useGscRange();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "clicks", dir: "desc" });
  const { data, isLoading, error } = useGetGscQueries({
    startDate: range.startDate,
    endDate: range.endDate,
    url: range.urlFilter ?? undefined,
    limit: 1000,
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.rows
      .filter((r) => (filter === "branded" ? r.isBranded : filter === "unbranded" ? !r.isBranded : true))
      .filter((r) => (search ? r.query.toLowerCase().includes(search.toLowerCase()) : true));
    const sorted = filtered.slice().sort((a, b) => {
      const av = a[sort.key] as string | number;
      const bv = b[sort.key] as string | number;
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [data, filter, search, sort]);

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="py-12 text-center text-sm text-destructive">Failed to load queries. {error instanceof Error ? error.message : ""}</div>;

  return (
    <div className="space-y-6">
      <HowThisWorks
        summary="Every search query that returned your site in the chosen date range, sortable by clicks, impressions, CTR, or position, with a branded / unbranded filter."
        steps={[
          { title: "Filter and search", body: "Toggle branded vs unbranded (matched against your brand patterns) and free-text search the query column." },
          { title: "Sort to find leverage", body: "Sort by impressions desc to find demand you're not converting; sort by position desc within high-impression rows to find quick-win pages." },
          { title: "Send winners back to the pipeline", body: "Promising queries should drive content updates — push the page in Pages or the optimizer queue." },
        ]}
        faqs={[
          { title: "Why are some queries hidden?", body: "GSC anonymizes long-tail / personal queries; only queries above their privacy threshold are returned." },
          { title: "How is CTR computed?", body: "GSC clicks divided by impressions for the selected scope — already deduped by Google." },
        ]}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              Branded
              <InfoTip>Queries that mention your brand. Used to separate captive demand from organic discovery.</InfoTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-4 gap-3">
            <MetricCard label="Clicks" value={data.brandedTotals.clicks} />
            <MetricCard label="Imps" value={data.brandedTotals.impressions} />
            <MetricCard label="CTR" value={data.brandedTotals.ctr} format="percent" />
            <MetricCard label="Pos" value={data.brandedTotals.position} format="decimal" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              Unbranded
              <InfoTip>Queries that don't mention your brand — the true measure of organic SEO performance.</InfoTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-4 gap-3">
            <MetricCard label="Clicks" value={data.unbrandedTotals.clicks} />
            <MetricCard label="Imps" value={data.unbrandedTotals.impressions} />
            <MetricCard label="CTR" value={data.unbrandedTotals.ctr} format="percent" />
            <MetricCard label="Pos" value={data.unbrandedTotals.position} format="decimal" />
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <InfoTip>Filter the query list to all, branded-only, or unbranded-only.</InfoTip>
        {(["all", "branded", "unbranded"] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)} className="capitalize">
            {f}
          </Button>
        ))}
        <Input placeholder="Search query..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs h-9" />
        <div className="text-xs text-muted-foreground ml-auto">{rows.length} rows</div>
        <CopyButton
          disabled={rows.length === 0}
          getText={() =>
            rowsToTsv(
              ["Query", "Clicks", "Impressions", "CTR", "Position"],
              rows.slice(0, 500).map((r) => [
                r.query,
                r.clicks,
                r.impressions,
                `${(r.ctr * 100).toFixed(2)}%`,
                r.position.toFixed(1),
              ]),
            )
          }
        />
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <SortableHeader col="query" label="Query" sort={sort} onChange={setSort} align="left" />
                <SortableHeader col="clicks" label="Clicks" sort={sort} onChange={setSort} />
                <SortableHeader col="impressions" label="Impressions" sort={sort} onChange={setSort} />
                <SortableHeader col="ctr" label="CTR" sort={sort} onChange={setSort} />
                <SortableHeader col="position" label="Position" sort={sort} onChange={setSort} />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.query} className="border-t hover:bg-muted/20">
                  <td className="p-3 max-w-md truncate">
                    {r.query}
                    {r.isBranded && <Badge variant="secondary" className="ml-2 text-[10px]">brand</Badge>}
                  </td>
                  <td className="p-3 text-right font-mono">{r.clicks}</td>
                  <td className="p-3 text-right font-mono">{r.impressions}</td>
                  <td className="p-3 text-right font-mono">{(r.ctr * 100).toFixed(2)}%</td>
                  <td className="p-3 text-right font-mono">{r.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GscQueriesPage() {
  return <GscLayout><QueriesBody /></GscLayout>;
}
