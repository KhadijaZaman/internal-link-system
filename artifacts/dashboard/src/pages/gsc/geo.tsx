import { useGetGscGeo } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

function DimTable({ title, rows, tip }: { title: string; rows: { key: string; clicks: number; impressions: number; ctr: number; position: number }[]; tip: string }) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-1.5">
          {title}
          <InfoTip>{tip}</InfoTip>
        </CardTitle>
        <CopyButton
          disabled={rows.length === 0}
          getText={() =>
            rowsToTsv(
              ["Key", "Clicks", "Imps", "CTR", "Pos"],
              rows.slice(0, 100).map((r) => [
                r.key || "(unknown)",
                r.clicks,
                r.impressions,
                `${(r.ctr * 100).toFixed(2)}%`,
                r.position.toFixed(1),
              ]),
            )
          }
        />
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left p-3">Key</th>
              <th className="text-right p-3">Clicks</th>
              <th className="text-right p-3">Imps</th>
              <th className="text-right p-3">CTR</th>
              <th className="text-right p-3">Pos</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-3">{r.key || "(unknown)"}</td>
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
  );
}

function GeoBody() {
  const { range } = useGscRange();
  const { data, isLoading, error } = useGetGscGeo({
    startDate: range.startDate,
    endDate: range.endDate,
    url: range.urlFilter ?? undefined,
  });
  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="py-12 text-center text-sm text-destructive">Failed to load geo data. {error instanceof Error ? error.message : ""}</div>;
  return (
    <div className="space-y-4">
      <HowThisWorks
        summary="Traffic split by visitor country and device, sourced from Search Console for the selected date range."
        steps={[
          { title: "Read the country table", body: "Top-clicks-first. Useful for spotting market mismatches — high impressions in a country where you don't sell is a content / hreflang signal." },
          { title: "Read the device table", body: "Compare mobile vs desktop CTR and position. A big gap usually points to mobile UX problems on your top landing pages." },
        ]}
        faqs={[
          { title: "Why are some small countries missing?", body: "GSC drops countries below its privacy threshold — they're rolled into 'other' or hidden entirely." },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DimTable title="Countries" rows={data.countries} tip="Search Console traffic broken down by visitor country, ranked by clicks." />
        <DimTable title="Devices" rows={data.devices} tip="Traffic split between mobile, desktop, and tablet devices." />
      </div>
    </div>
  );
}

export default function GscGeoPage() {
  return <GscLayout><GeoBody /></GscLayout>;
}
