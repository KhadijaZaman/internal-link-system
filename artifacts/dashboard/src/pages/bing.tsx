import { useMemo, useRef, useState } from "react";
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
