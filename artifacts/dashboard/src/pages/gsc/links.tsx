import { useMemo, useState } from "react";
import { useGetGscLinks } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

interface ParsedLinkRow {
  key: string;
  count: number;
}

function parseGscLinksCsv(text: string): ParsedLinkRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const map = new Map<string, number>();
  for (const line of lines) {
    if (line.toLowerCase().startsWith("top sites") || line.toLowerCase().startsWith("top pages")) continue;
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 2) continue;
    const [key, countStr] = cols;
    if (!key || key.toLowerCase() === "domain" || key.toLowerCase() === "url" || key.toLowerCase() === "site") continue;
    const count = parseInt((countStr ?? "").replace(/[^\d]/g, ""), 10);
    if (Number.isNaN(count)) continue;
    map.set(key, (map.get(key) ?? 0) + count);
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function LinksBody() {
  const { data, isLoading, error } = useGetGscLinks();
  const [csv, setCsv] = useState("");
  const parsed = useMemo(() => parseGscLinksCsv(csv), [csv]);

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="py-12 text-center text-sm text-destructive">Failed to load links data. {error instanceof Error ? error.message : ""}</div>;
  return (
    <div className="space-y-4">
      <HowThisWorks
        summary="External link data straight from Search Console — top linking sites, top linked pages, and top anchor texts. Paste the GSC export CSV to compare against your live state."
        steps={[
          { title: "Review what GSC sees", body: "The cards show the most-linked pages on your site, the domains linking to you most, and the anchor text distribution Google has recorded." },
          { title: "Paste a GSC export", body: "Go to Search Console → Links → Export → Top linking sites (or Top pages) and paste the CSV. We parse it and show the delta — useful for tracking link growth over time." },
        ]}
        faqs={[
          { title: "Why doesn't this match my backlink tool?", body: "GSC sees its own crawl of links to your site, which is usually narrower than third-party tools (Ahrefs, Majestic). Treat this as Google's authoritative view." },
        ]}
      />

      {data.notice && <div className="border rounded-md p-3 text-sm bg-muted/30">{data.notice}</div>}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              Top External Linking Domains (DataForSEO)
              <InfoTip>Domains that link to your site, ranked by total backlinks. Sourced from DataForSEO's backlink index.</InfoTip>
            </CardTitle>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["Domain", "Backlinks", "Rank", "First Seen", "Last Seen"],
                  data.topExternalLinkingDomains.map((d) => [
                    d.domain,
                    d.backlinks,
                    d.rank ?? "—",
                    d.firstSeen ? new Date(d.firstSeen).toLocaleDateString() : "—",
                    d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : "—",
                  ]),
                )
              }
              disabled={data.topExternalLinkingDomains.length === 0}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {data.externalNotice && (
            <div className="px-4 py-3 text-xs text-muted-foreground">{data.externalNotice}</div>
          )}
          {data.topExternalLinkingDomains.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="text-left p-3">Domain</th>
                  <th className="text-right p-3">Backlinks</th>
                  <th className="text-right p-3">Rank</th>
                  <th className="text-right p-3">First Seen</th>
                  <th className="text-right p-3">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {data.topExternalLinkingDomains.map((d) => (
                  <tr key={d.domain} className="border-t">
                    <td className="p-3">{d.domain}</td>
                    <td className="p-3 text-right font-mono">{d.backlinks}</td>
                    <td className="p-3 text-right font-mono">{d.rank ?? "—"}</td>
                    <td className="p-3 text-right text-xs">{d.firstSeen ? new Date(d.firstSeen).toLocaleDateString() : "—"}</td>
                    <td className="p-3 text-right text-xs">{d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !data.externalNotice && (
              <div className="p-4 text-sm text-muted-foreground">No external linking domains returned.</div>
            )
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                Top Internal Targets (our crawl)
                <InfoTip>Pages on your site that receive the most internal links, based on the latest site crawl.</InfoTip>
              </CardTitle>
              <CopyButton
                getText={() =>
                  rowsToTsv(
                    ["Target", "Links"],
                    data.topInternalTargets.map((r) => [r.key, r.count]),
                  )
                }
                disabled={data.topInternalTargets.length === 0}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {data.topInternalTargets.map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="p-2 text-primary truncate max-w-md">{r.key}</td>
                    <td className="p-2 text-right font-mono">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                Top Internal Target Hosts
                <InfoTip>Hosts (domain or subdomain) receiving the most internal links from your site.</InfoTip>
              </CardTitle>
              <CopyButton
                getText={() =>
                  rowsToTsv(
                    ["Host", "Links"],
                    data.topLinkingDomains.map((r) => [r.key, r.count]),
                  )
                }
                disabled={data.topLinkingDomains.length === 0}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {data.topLinkingDomains.map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="p-2">{r.key}</td>
                    <td className="p-2 text-right font-mono">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              Optional: paste GSC &quot;Top linking sites&quot; CSV
              <InfoTip>Paste the CSV exported from Search Console's Links report to cross-check the DataForSEO backlink figures above.</InfoTip>
            </CardTitle>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["Domain / URL", "Links"],
                  parsed.slice(0, 100).map((r) => [r.key, r.count]),
                )
              }
              disabled={parsed.length === 0}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Cross-check the DataForSEO figures above against Search Console&apos;s own report by pasting the
            exported CSV here.
          </p>
          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={5}
            placeholder={'example.com,1234\nblog.example.org,567'}
            className="font-mono text-xs"
          />
          {parsed.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Domain / URL</th>
                  <th className="text-right p-2">Links</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 100).map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="p-2 truncate max-w-xl">{r.key}</td>
                    <td className="p-2 text-right font-mono">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function GscLinksPage() {
  return <GscLayout showControls={false}><LinksBody /></GscLayout>;
}
