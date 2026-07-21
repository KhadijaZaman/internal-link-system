import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useGetBingPages,
  useListAiCitationUploads,
  useUploadAiCitations,
  useRunJob,
  getGetBingPagesQueryKey,
  getListAiCitationUploadsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SortableHeader, type SortState } from "@/components/gsc/sortable-header";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { DataNarrative, Num, type NarrativeInsight } from "@/components/data-narrative";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { useToast } from "@/hooks/use-toast";
import { Upload, RefreshCw } from "lucide-react";

type SortKey =
  | "path"
  | "gscClicks"
  | "gscImpressions"
  | "gscPosition"
  | "bingClicks"
  | "bingImpressions"
  | "bingPosition"
  | "aiCitations"
  | "aiSessions";

const MAX_UPLOAD_CHARS = 1_500_000;

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-display mt-1">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground mt-1">{hint}</div> : null}
    </div>
  );
}

function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString();
}

function fmtPos(v: number | null | undefined): string {
  return v === null || v === undefined || v === 0 ? "—" : v.toFixed(1);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

export default function BingPage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "aiCitations", dir: "desc" });
  const fileInput = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useGetBingPages();
  const uploadsQ = useListAiCitationUploads();
  const upload = useUploadAiCitations();
  const runJob = useRunJob();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getGetBingPagesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListAiCitationUploadsQueryKey() });
  };

  const onFilePicked = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      if (!content.trim()) {
        toast({ title: "Empty file", description: "That file has no content.", variant: "destructive" });
        return;
      }
      if (content.length > MAX_UPLOAD_CHARS) {
        toast({
          title: "File too large",
          description: "Exports over ~1.5 MB of text aren't supported.",
          variant: "destructive",
        });
        return;
      }
      upload.mutate(
        { data: { label: file.name, content } },
        {
          onSuccess: (result) => {
            invalidate();
            const w = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
            toast({
              title: `Upload processed (${result.upload.kind === "pages" ? "page citations" : "grounding queries"})`,
              description:
                `${result.upload.rowCount.toLocaleString()} rows, ` +
                `${result.totalCitations.toLocaleString()} citations` +
                (result.upload.kind === "pages" ? `, ${result.matchedPages.toLocaleString()} pages matched.` : ".") +
                w,
            });
          },
          onError: (e) => {
            const body = e.data as { error?: string } | null;
            toast({
              title: "Upload failed",
              description: body?.error ?? "The file could not be parsed.",
              variant: "destructive",
            });
          },
        },
      );
    };
    reader.readAsText(file);
  };

  const onSyncNow = () => {
    runJob.mutate(
      { jobName: "sync_bing_pages" },
      {
        onSuccess: () => {
          toast({
            title: "Bing sync started",
            description: "Fetching the latest ~6 months of Bing page and query stats. Refresh in a minute.",
          });
          setTimeout(invalidate, 45_000);
        },
        onError: () =>
          toast({ title: "Could not start sync", description: "It may already be running.", variant: "destructive" }),
      },
    );
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.rows.filter((r) =>
      search ? r.path.toLowerCase().includes(search.toLowerCase()) : true,
    );
    return filtered.slice().sort((a, b) => {
      const av = a[sort.key] ?? (sort.key === "path" ? "" : -1);
      const bv = b[sort.key] ?? (sort.key === "path" ? "" : -1);
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data, search, sort]);

  const groundingUploads = (uploadsQ.data ?? []).filter((u) => u.kind === "grounding_queries");

  const narrative = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    let gscImp = 0;
    let bingImp = 0;
    let gPosW = 0;
    let gPosImp = 0;
    let bPosW = 0;
    let bPosImp = 0;
    for (const r of data.rows) {
      const gi = r.gscImpressions ?? 0;
      const bi = r.bingImpressions ?? 0;
      gscImp += gi;
      bingImp += bi;
      if (r.gscPosition != null && r.gscPosition > 0 && gi > 0) {
        gPosW += r.gscPosition * gi;
        gPosImp += gi;
      }
      if (r.bingPosition != null && r.bingPosition > 0 && bi > 0) {
        bPosW += r.bingPosition * bi;
        bPosImp += bi;
      }
    }
    const gPos = gPosImp > 0 ? gPosW / gPosImp : null;
    const bPos = bPosImp > 0 ? bPosW / bPosImp : null;
    const t = data.totals;
    const hasCitations = t.aiCitations > 0;

    const paragraphs: React.ReactNode[] = [
      <>
        Your pages appeared <Num>{gscImp.toLocaleString()} times</Num> in Google search results and{" "}
        <Num>{bingImp.toLocaleString()} times</Num> in Bing (those are &quot;impressions&quot; — being
        shown, whether or not anyone clicked). Note the windows differ: Google numbers cover the latest
        GSC sync (~28 days), while Bing&apos;s cover roughly the last 6 months — so don&apos;t compare
        them head-to-head.
        {gPos !== null || bPos !== null ? (
          <>
            {" "}
            When shown, you ranked around{" "}
            {gPos !== null ? <Num>#{gPos.toFixed(1)} on Google</Num> : null}
            {gPos !== null && bPos !== null ? " and " : null}
            {bPos !== null ? <Num>#{bPos.toFixed(1)} on Bing</Num> : null} on average — lower means
            closer to the top of the page.
          </>
        ) : null}
      </>,
      <>
        Those appearances turned into <Num>{t.gscClicks.toLocaleString()} Google clicks</Num> and{" "}
        <Num>{t.bingClicks.toLocaleString()} Bing clicks</Num> — real people choosing your result over
        everything else on the page.
      </>,
      hasCitations ? (
        <>
          Beyond classic search, AI answers (Copilot / Bing AI) quoted your pages as a source{" "}
          <Num>{t.aiCitations.toLocaleString()} times</Num>, and AI assistants like ChatGPT and
          Perplexity sent <Num>{t.aiSessions.toLocaleString()} actual visits</Num> in the last 28 days.
          Being cited builds brand visibility even when there is no click to count.
        </>
      ) : (
        <>
          No AI-citation data yet — upload the AI Performance export from Bing Webmaster Tools (button
          above) to see how often AI answers quote your pages as a source.
        </>
      ),
    ];

    const insights: NarrativeInsight[] = [];
    const topCited = data.rows
      .filter((r) => (r.aiCitations ?? 0) > 0)
      .sort((a, b) => (b.aiCitations ?? 0) - (a.aiCitations ?? 0))[0];
    if (topCited) {
      insights.push({
        tone: "good",
        text: (
          <>
            AI&apos;s favorite source on your site is <Num>{topCited.path}</Num> — cited{" "}
            <Num>{(topCited.aiCitations ?? 0).toLocaleString()} times</Num>.
          </>
        ),
      });
    }
    const hiddenGems = data.rows.filter(
      (r) => (r.aiCitations ?? 0) >= 5 && (r.gscClicks ?? 0) < 10,
    ).length;
    if (hiddenGems > 0) {
      insights.push({
        tone: "warn",
        text: (
          <>
            <Num>{hiddenGems} page{hiddenGems === 1 ? "" : "s"}</Num> are quoted often by AI but get
            almost no Google clicks — AI values them more than Google currently rewards them. Sort the
            table by AI citations to find them.
          </>
        ),
      });
    }
    if (t.gscClicks > 0 && t.bingClicks > 0) {
      const per100 = Math.round((t.bingClicks / t.gscClicks) * 100);
      insights.push({
        tone: "neutral",
        text: (
          <>
            For every <Num>100 Google clicks</Num>, Bing brings roughly <Num>{per100}</Num> — keep in
            mind the Bing window is ~6 months while GSC reflects the latest sync.
          </>
        ),
      });
    }
    return { paragraphs, insights };
  }, [data]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        <div className="flex-1">
          <h2 className="text-3xl font-display text-foreground">Bing &amp; AI Citations</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Bing organic performance (synced daily from the Bing Webmaster API) and Copilot / Bing AI
            citations (uploaded from the AI Performance report) — mapped page-by-page against Google
            Search Console.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSyncNow} disabled={runJob.isPending}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Sync Bing now
          </Button>
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Spinner className="h-4 w-4 mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
            Upload AI Performance export
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFilePicked(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <HowThisWorks
        summary="Google is not the only search surface anymore. This page lines up three views of every page: Google Search (GSC clicks/impressions/position), Bing organic (same metrics from the Bing Webmaster API, rolling ~6 months), and AI answers (how often Copilot / Bing AI cited the page as a source, plus AI-assistant sessions from GA4)."
        steps={[
          {
            title: "Bing stats sync automatically",
            body: "A daily job pulls the Bing Webmaster API's rolling ~6-month window of page and query stats. You can also click 'Sync Bing now'.",
          },
          {
            title: "AI citations arrive by upload",
            body: "Microsoft has not shipped an API for the AI Performance report yet (promised later in 2026). Export it from Bing Webmaster Tools → AI Performance, then upload the file here. Both the page-citations export and the grounding-queries export are recognized; re-uploading replaces the previous snapshot.",
          },
          {
            title: "Compare per page",
            body: "Sort by AI citations to see which pages AI answers lean on, then check whether those pages also earn Google clicks. High citations + low GSC clicks = pages winning in AI surfaces that classic search under-rewards (and vice versa).",
          },
        ]}
        faqs={[
          {
            title: "Why don't Bing numbers match the Bing website exactly?",
            body: "URL variants (www, trailing slashes, #anchors) are collapsed onto one canonical page here, and the API window is a rolling ~6 months — so totals can differ slightly from the Bing UI.",
          },
          {
            title: "What's the difference between AI citations and AI sessions?",
            body: "Citations count how often a page was shown as a source inside Copilot / Bing AI answers (from your upload). AI sessions count actual visits referred by AI assistants — ChatGPT, Claude, Perplexity, Gemini, Copilot — measured by GA4.",
          },
          {
            title: "GSC vs Bing position?",
            body: "Both are average impression positions, but the windows differ: GSC columns reflect the latest GSC sync, Bing columns the ~6-month API window. Use them directionally.",
          },
        ]}
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error || !data ? (
        <div className="py-12 text-center text-sm text-destructive">
          Failed to load. {error instanceof Error ? error.message : ""}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Google clicks" value={data.totals.gscClicks.toLocaleString()} hint="latest GSC sync" />
            <StatCard
              label="Bing clicks"
              value={data.totals.bingClicks.toLocaleString()}
              hint={`~6 mo · synced ${fmtDate(data.bingSyncedAt)}`}
            />
            <StatCard
              label="AI citations"
              value={data.totals.aiCitations.toLocaleString()}
              hint={
                data.latestUpload
                  ? `from "${data.latestUpload.label}" · ${fmtDate(data.latestUpload.uploadedAt)}`
                  : "no upload yet"
              }
            />
            <StatCard label="AI sessions" value={data.totals.aiSessions.toLocaleString()} hint="GA4, 28-day window" />
          </div>

          {narrative ? (
            <DataNarrative paragraphs={narrative.paragraphs} insights={narrative.insights} />
          ) : null}

          {data.totals.bingClicks === 0 && data.bingSyncedAt === null ? (
            <div className="border rounded-lg p-4 bg-muted/30 text-sm text-muted-foreground">
              Bing stats haven't been synced yet — click <span className="font-medium">Sync Bing now</span> to
              pull the first ~6 months of data.
            </div>
          ) : null}

          <div className="flex gap-2 items-center">
            <InfoTip>
              Every page with any Google, Bing, AI-citation, or AI-session activity. Sort by AI
              citations to see what AI answers rely on.
            </InfoTip>
            <Input
              placeholder="Filter path..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-md h-9"
            />
            <div className="text-xs text-muted-foreground ml-auto">{rows.length} pages</div>
            <Link
              href="/report"
              className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
            >
              Full per-page picture → Page Report
            </Link>
            <CopyButton
              disabled={rows.length === 0}
              getText={() =>
                rowsToTsv(
                  [
                    "Path",
                    "GSC Clicks",
                    "GSC Impressions",
                    "GSC Position",
                    "Bing Clicks",
                    "Bing Impressions",
                    "Bing Position",
                    "AI Citations",
                    "AI Sessions",
                  ],
                  rows.slice(0, 2000).map((r) => [
                    r.path,
                    r.gscClicks ?? 0,
                    r.gscImpressions ?? 0,
                    r.gscPosition?.toFixed(1) ?? "",
                    r.bingClicks ?? 0,
                    r.bingImpressions ?? 0,
                    r.bingPosition?.toFixed(1) ?? "",
                    r.aiCitations ?? 0,
                    r.aiSessions ?? 0,
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
                    <SortableHeader col="path" label="Path" sort={sort} onChange={setSort} align="left" />
                    <SortableHeader col="gscClicks" label="GSC Clicks" sort={sort} onChange={setSort} />
                    <SortableHeader col="gscImpressions" label="GSC Impr." sort={sort} onChange={setSort} />
                    <SortableHeader col="gscPosition" label="GSC Pos." sort={sort} onChange={setSort} />
                    <SortableHeader col="bingClicks" label="Bing Clicks" sort={sort} onChange={setSort} />
                    <SortableHeader col="bingImpressions" label="Bing Impr." sort={sort} onChange={setSort} />
                    <SortableHeader col="bingPosition" label="Bing Pos." sort={sort} onChange={setSort} />
                    <SortableHeader col="aiCitations" label="AI Citations" sort={sort} onChange={setSort} />
                    <SortableHeader col="aiSessions" label="AI Sessions" sort={sort} onChange={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 2000).map((r) => (
                    <tr key={r.path} className="border-t hover:bg-muted/20">
                      <td className="p-3 max-w-xl truncate text-primary" title={r.title ?? r.path}>
                        {r.path}
                      </td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.gscClicks)}</td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.gscImpressions)}</td>
                      <td className="p-3 text-right font-mono">{fmtPos(r.gscPosition)}</td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.bingClicks)}</td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.bingImpressions)}</td>
                      <td className="p-3 text-right font-mono">{fmtPos(r.bingPosition)}</td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.aiCitations)}</td>
                      <td className="p-3 text-right font-mono">{fmtNum(r.aiSessions)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-muted-foreground">
                        No pages with activity yet. Sync Bing or upload an AI Performance export to get
                        started.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {(uploadsQ.data ?? []).length > 0 ? (
            <Card>
              <CardContent className="p-4">
                <div className="text-sm font-medium mb-2">Upload history</div>
                <div className="space-y-1">
                  {(uploadsQ.data ?? []).map((u) => (
                    <div key={u.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Badge variant="outline">
                        {u.kind === "pages" ? "page citations" : "grounding queries"}
                      </Badge>
                      <span className="truncate max-w-xs" title={u.label}>
                        {u.label}
                      </span>
                      <span className="font-mono text-xs">{u.rowCount.toLocaleString()} rows</span>
                      {u.unmatchedCount > 0 ? (
                        <span className="text-xs text-amber-600">{u.unmatchedCount} unmatched</span>
                      ) : null}
                      <span className="text-xs ml-auto">{fmtDate(u.uploadedAt)}</span>
                    </div>
                  ))}
                </div>
                {groundingUploads.length > 0 ? (
                  <p className="text-xs text-muted-foreground mt-3">
                    Grounding-query uploads are stored for reference; the mapping table above uses the
                    newest page-citations upload.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
