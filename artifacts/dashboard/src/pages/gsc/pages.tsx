import { useMemo, useState } from "react";
import { useGetGscPages, useGetGscUrlDrilldown, getGetGscUrlDrilldownQueryKey } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { TrendChart } from "@/components/gsc/trend-chart";
import { SortableHeader, type SortState } from "@/components/gsc/sortable-header";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

type SortKey = "url" | "clicks" | "impressions" | "ctr" | "position";

function PagesBody() {
  const { range } = useGscRange();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "clicks", dir: "desc" });
  const [drilldown, setDrilldown] = useState<string | null>(null);
  const { data, isLoading, error } = useGetGscPages({
    startDate: range.startDate,
    endDate: range.endDate,
    url: range.urlFilter ?? undefined,
    limit: 1000,
  });
  const drillParams = { url: drilldown ?? "", startDate: range.startDate, endDate: range.endDate };
  const { data: drillData, isLoading: drillLoading } = useGetGscUrlDrilldown(
    drillParams,
    { query: { enabled: !!drilldown, queryKey: getGetGscUrlDrilldownQueryKey(drillParams) } },
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.rows.filter((r) => (search ? r.url.toLowerCase().includes(search.toLowerCase()) : true));
    return filtered.slice().sort((a, b) => {
      const av = a[sort.key] as string | number;
      const bv = b[sort.key] as string | number;
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data, search, sort]);

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="py-12 text-center text-sm text-destructive">Failed to load pages. {error instanceof Error ? error.message : ""}</div>;

  return (
    <div className="space-y-6">
      <HowThisWorks
        summary="Per-URL performance from Search Console. Click any row to drill into that page's trend and its top queries side-by-side."
        steps={[
          { title: "Filter to a slice", body: "Use the URL search to narrow to a path (e.g. /blog/). The selected URL filter from the top bar carries over to every row." },
          { title: "Sort the table", body: "Sort by clicks for top performers, impressions for opportunity, or position to surface stuck pages." },
          { title: "Drill into a page", body: "Clicking a row pulls the page's daily trend and top queries so you can decide whether to optimize, prune, or leave alone." },
        ]}
        faqs={[
          { title: "Why don't totals match Overview?", body: "GSC double-counts at finer granularities; per-page totals will sum higher than the deduplicated site total." },
          { title: "What's a good next step from here?", body: "High-impression / low-CTR pages are great candidates for the Optimization Queue — send them to the optimizer for a rewrite brief." },
        ]}
      />
      <div className="flex gap-2 items-center">
        <InfoTip>Every page that received clicks or impressions in this date range. Click a row to see its trend and top queries.</InfoTip>
        <Input placeholder="Filter URL..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-md h-9" />
        <div className="text-xs text-muted-foreground ml-auto">{rows.length} pages</div>
        <CopyButton
          disabled={rows.length === 0}
          getText={() =>
            rowsToTsv(
              ["URL", "Clicks", "Impressions", "CTR", "Position"],
              rows.slice(0, 500).map((r) => [
                r.url,
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
                <SortableHeader col="url" label="URL" sort={sort} onChange={setSort} align="left" />
                <SortableHeader col="clicks" label="Clicks" sort={sort} onChange={setSort} />
                <SortableHeader col="impressions" label="Impressions" sort={sort} onChange={setSort} />
                <SortableHeader col="ctr" label="CTR" sort={sort} onChange={setSort} />
                <SortableHeader col="position" label="Position" sort={sort} onChange={setSort} />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr
                  key={r.url}
                  className="border-t hover:bg-muted/20 cursor-pointer"
                  onClick={() => setDrilldown(r.url)}
                >
                  <td className="p-3 max-w-xl truncate text-primary">{r.url}</td>
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

      {drilldown && (
        <Card className="border-primary">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm truncate flex items-center gap-1.5">
              {drilldown}
              <InfoTip>Per-URL breakdown: clicks and impressions trend and the top search queries driving traffic to this page.</InfoTip>
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setDrilldown(null)}><X className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent>
            {drillLoading || !drillData ? (
              <Spinner className="h-6 w-6" />
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                    Clicks & impressions trend
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <TrendChart data={drillData.timeseries} metric="clicks" />
                    <TrendChart data={drillData.timeseries} metric="impressions" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Top queries for this page</div>
                  <CopyButton
                    disabled={drillData.queries.length === 0}
                    getText={() =>
                      rowsToTsv(
                        ["Query", "Clicks", "Imps", "Pos"],
                        drillData.queries.slice(0, 50).map((q) => [
                          q.query,
                          q.clicks,
                          q.impressions,
                          q.position.toFixed(1),
                        ]),
                      )
                    }
                  />
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase">
                    <tr>
                      <th className="text-left p-2">Query</th>
                      <th className="text-right p-2">Clicks</th>
                      <th className="text-right p-2">Imps</th>
                      <th className="text-right p-2">Pos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.queries.slice(0, 50).map((q) => (
                      <tr key={q.query} className="border-t">
                        <td className="p-2 max-w-md truncate">{q.query}</td>
                        <td className="p-2 text-right font-mono">{q.clicks}</td>
                        <td className="p-2 text-right font-mono">{q.impressions}</td>
                        <td className="p-2 text-right font-mono">{q.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function GscPagesPage() {
  return <GscLayout><PagesBody /></GscLayout>;
}
