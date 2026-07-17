import { useState } from "react";
import {
  useGetGscIndexing,
  useInspectGscUrl,
  getInspectGscUrlQueryKey,
  useInspectGscBatch,
} from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

function IndexingBody() {
  const { data, isLoading, error } = useGetGscIndexing();
  const [url, setUrl] = useState("");
  const [inspectUrl, setInspectUrl] = useState<string | null>(null);
  const inspectParams = { url: inspectUrl ?? "" };
  const { data: insp, isLoading: inspLoading } = useInspectGscUrl(
    inspectParams,
    { query: { enabled: !!inspectUrl, queryKey: getInspectGscUrlQueryKey(inspectParams) } },
  );
  const batchMut = useInspectGscBatch();

  const runBatch = (n: number) => {
    if (!data?.notIndexedCandidates?.length) return;
    const urls = data.notIndexedCandidates.slice(0, n).map((c) => c.url);
    batchMut.mutate({ data: { urls } });
  };

  return (
    <div className="space-y-6">
      <HowThisWorks
        summary="Indexing health — which sitemap URLs Google is actually indexing, plus on-demand URL Inspection against the Search Console API for one URL or a batch."
        steps={[
          { title: "Check the bucket counts", body: "We compare your sitemap to GSC's index coverage and bucket URLs into indexed, not-indexed, crawled-not-indexed, discovered, and excluded." },
          { title: "Inspect a URL", body: "Paste any URL to get GSC's live verdict: indexing state, last crawl, canonical, mobile usability, and rich-results status." },
          { title: "Run a batch inspection", body: "Use the buttons to inspect the top N not-indexed candidates in one click — useful for triaging post-publish issues." },
        ]}
        faqs={[
          { title: "Why is a freshly published URL not indexed?", body: "Google needs time to crawl + decide. Use Inspect to confirm it's discoverable, then Request Indexing in the GSC UI if needed." },
          { title: "Does this consume my GSC quota?", body: "Yes. The URL Inspection API has a daily cap (~2,000/day) — batch inspection is rate-limited to stay under it." },
        ]}
      />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              Sitemaps
              <InfoTip>Sitemaps submitted to Google Search Console with their submission status, errors, warnings, and URL counts.</InfoTip>
            </CardTitle>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["Sitemap", "Submitted", "Downloaded", "Errors", "Warnings", "URLs"],
                  (data?.sitemaps ?? []).map((s) => [
                    s.path,
                    s.lastSubmitted ? new Date(s.lastSubmitted).toLocaleDateString() : "—",
                    s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString() : "—",
                    s.errors ?? 0,
                    s.warnings ?? 0,
                    (s.contents ?? []).reduce((sum, c) => sum + c.submitted, 0),
                  ]),
                )
              }
              disabled={!data || data.sitemaps.length === 0}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? <div className="p-6"><Spinner className="h-6 w-6" /></div> : error || !data ? (
            <div className="p-6 text-sm text-destructive">Failed to load indexing data. {error instanceof Error ? error.message : ""}</div>
          ) : (
            <>
              {data.notice && <div className="px-4 py-3 text-xs text-muted-foreground">{data.notice}</div>}
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase">
                  <tr>
                    <th className="text-left p-3">Sitemap</th>
                    <th className="text-left p-3">Submitted</th>
                    <th className="text-left p-3">Downloaded</th>
                    <th className="text-right p-3">Errors</th>
                    <th className="text-right p-3">Warnings</th>
                    <th className="text-right p-3">URLs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sitemaps.map((s) => {
                    const totalSubmitted = (s.contents ?? []).reduce((sum, c) => sum + c.submitted, 0);
                    return (
                      <tr key={s.path} className="border-t">
                        <td className="p-3 text-primary truncate max-w-md">{s.path}</td>
                        <td className="p-3 text-xs">{s.lastSubmitted ? new Date(s.lastSubmitted).toLocaleDateString() : "—"}</td>
                        <td className="p-3 text-xs">{s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString() : "—"}</td>
                        <td className="p-3 text-right">{s.errors ? <Badge variant="destructive">{s.errors}</Badge> : "0"}</td>
                        <td className="p-3 text-right">{s.warnings ?? "0"}</td>
                        <td className="p-3 text-right font-mono">{totalSubmitted}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between gap-4 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              Likely not-indexed URLs
              <InfoTip>URLs from your crawl with zero GSC impressions over the recent window — likely missing from Google's index. Click Inspect to confirm via the GSC URL Inspection API.</InfoTip>
              {data && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({data.notIndexedCandidates?.length ?? 0} candidates
                  {data.candidatesWindowStart && data.candidatesWindowEnd
                    ? ` · 0 impressions ${data.candidatesWindowStart} → ${data.candidatesWindowEnd}`
                    : ""}
                  )
                </span>
              )}
            </span>
            <div className="flex gap-2 items-center">
              <span className="text-xs font-normal text-muted-foreground">Verify with GSC:</span>
              <InfoTip>Run the GSC URL Inspection API against the top 10 candidates to get Google's official coverage reason for each.</InfoTip>
              <Button size="sm" variant="outline" disabled={batchMut.isPending || !data?.notIndexedCandidates?.length} onClick={() => runBatch(10)}>
                {batchMut.isPending ? <Spinner className="h-3 w-3" /> : "Inspect top 10"}
              </Button>
              <CopyButton
                getText={() =>
                  rowsToTsv(
                    ["URL", "Heuristic"],
                    (data?.notIndexedCandidates ?? []).slice(0, 200).map((c) => [c.url, c.reason]),
                  )
                }
                disabled={!data?.notIndexedCandidates?.length}
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {batchMut.data && (
            <div className="p-4 border-b bg-muted/20 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  GSC coverage reasons ({batchMut.data.inspected} URLs inspected)
                </div>
                <CopyButton
                  getText={() =>
                    rowsToTsv(
                      ["URL", "Coverage State"],
                      (batchMut.data?.results ?? []).map((r) => [
                        r.url,
                        r.coverageState ?? r.error ?? "—",
                      ]),
                    )
                  }
                  disabled={!batchMut.data?.results?.length}
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                {batchMut.data.reasons.map((r) => (
                  <Badge
                    key={r.reason}
                    variant={r.reason === "Submitted and indexed" ? "default" : r.reason.toLowerCase().includes("not") ? "destructive" : "secondary"}
                  >
                    {r.reason}: {r.count}
                  </Badge>
                ))}
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Per-URL detail</summary>
                <table className="w-full mt-2">
                  <tbody>
                    {batchMut.data.results.map((r) => (
                      <tr key={r.url} className="border-t">
                        <td className="p-2 font-mono truncate max-w-xl">{r.url}</td>
                        <td className="p-2">{r.coverageState ?? r.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
          {!data ? null : data.notIndexedCandidates && data.notIndexedCandidates.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="text-left p-3">URL</th>
                  <th className="text-left p-3">Heuristic</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.notIndexedCandidates.slice(0, 200).map((c) => (
                  <tr key={c.url} className="border-t">
                    <td className="p-3 text-primary truncate max-w-xl">{c.url}</td>
                    <td className="p-3"><Badge variant="secondary">{c.reason}</Badge></td>
                    <td className="p-3 text-right">
                      <span className="inline-flex items-center gap-1">
                        <InfoTip>Ask Google Search Console for the live indexing status, coverage reason, and last crawl date for this single URL.</InfoTip>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setUrl(c.url);
                            setInspectUrl(c.url);
                          }}
                        >
                          Inspect
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              No not-indexed candidates detected. Either every inventory URL has GSC impressions, or the crawl
              inventory is empty.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-1.5">
            URL Inspection
            <InfoTip>Ad-hoc inspection of any URL on the site. Returns Google's verdict, coverage state, mobile usability, canonical, and last crawl time.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (url) setInspectUrl(url);
            }}
            className="flex gap-2 items-center"
          >
            <Input
              placeholder="https://wellows.com/page-to-inspect"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="flex-1"
            />
            <InfoTip>Submit this URL to the Google Search Console Inspection API.</InfoTip>
            <Button type="submit" disabled={!url || inspLoading}>Inspect</Button>
          </form>

          {inspectUrl && (inspLoading ? <Spinner className="h-6 w-6" /> : insp && (
            <div className="border rounded-md p-4 space-y-2 text-sm bg-muted/20">
              <div className="font-mono text-xs truncate">{insp.url}</div>
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-muted-foreground">Verdict:</span> <Badge>{insp.verdict ?? "—"}</Badge></div>
                <div><span className="text-muted-foreground">Coverage:</span> {insp.coverageState ?? "—"}</div>
                <div><span className="text-muted-foreground">Indexing:</span> {insp.indexingState ?? "—"}</div>
                <div><span className="text-muted-foreground">Robots:</span> {insp.robotsTxtState ?? "—"}</div>
                <div><span className="text-muted-foreground">Page fetch:</span> {insp.pageFetchState ?? "—"}</div>
                <div><span className="text-muted-foreground">Mobile:</span> {insp.mobileUsability ?? "—"}</div>
                <div className="col-span-2"><span className="text-muted-foreground">Google canonical:</span> <span className="text-xs">{insp.googleCanonical ?? "—"}</span></div>
                <div className="col-span-2"><span className="text-muted-foreground">Last crawl:</span> {insp.lastCrawlTime ? new Date(insp.lastCrawlTime).toLocaleString() : "—"}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export default function GscIndexingPage() {
  return <GscLayout showControls={false}><IndexingBody /></GscLayout>;
}
