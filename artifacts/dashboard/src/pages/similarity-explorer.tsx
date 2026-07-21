import { useMemo, useState } from "react";
import {
  useListSimilarityRuns,
  getListSimilarityRunsQueryKey,
  useGetSimilarityRun,
  getGetSimilarityRunQueryKey,
  useStartSimilarityRun,
  type SimilarityRun,
  type SimilarityArticle,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ExternalLink,
  GitCompareArrows,
  Play,
  Sparkles,
} from "lucide-react";

const MAX_URLS = 100;

function parseUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function runLabel(r: SimilarityRun): string {
  const date = new Date(r.createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} — ${r.urls.length} URLs`;
}

function displayName(a: { url: string; title: string | null }): string {
  if (a.title) return a.title;
  try {
    const u = new URL(a.url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return a.url;
  }
}

function simColor(sim: number): string {
  if (sim >= 0.6) return "bg-emerald-500";
  if (sim >= 0.45) return "bg-blue-500";
  return "bg-slate-400";
}

function SimBar({ sim }: { sim: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${simColor(sim)}`}
          style={{ width: `${Math.round(sim * 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">
        {(sim * 100).toFixed(1)}%
      </span>
    </div>
  );
}

const CLUSTER_COLORS = [
  "bg-blue-100 text-blue-800 border-blue-200",
  "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-purple-100 text-purple-800 border-purple-200",
  "bg-rose-100 text-rose-800 border-rose-200",
  "bg-cyan-100 text-cyan-800 border-cyan-200",
  "bg-lime-100 text-lime-800 border-lime-200",
  "bg-orange-100 text-orange-800 border-orange-200",
];

export default function SimilarityExplorer() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const runsQ = useListSimilarityRuns({
    query: {
      queryKey: getListSimilarityRunsQueryKey(),
      refetchInterval: (query) => {
        const rows = query.state.data ?? [];
        return rows.some((r) => r.status === "queued" || r.status === "running")
          ? 3000
          : false;
      },
    },
  });
  const runs = runsQ.data ?? [];
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "running");
  const completeRuns = runs.filter((r) => r.status === "complete");
  const failedLatest =
    !activeRun && runs.length > 0 && runs[0]!.status !== "complete" ? runs[0] : null;
  const selectedRun =
    completeRuns.find((r) => r.id === selectedRunId) ?? completeRuns[0] ?? null;

  const startMutation = useStartSimilarityRun({
    mutation: {
      onSuccess: () => {
        setSelectedRunId(null);
        void queryClient.invalidateQueries({ queryKey: getListSimilarityRunsQueryKey() });
      },
      onError: (err: unknown) => {
        const message =
          err && typeof err === "object" && "error" in err && typeof err.error === "string"
            ? err.error
            : "Could not start the analysis.";
        toast({ title: "Analysis not started", description: message, variant: "destructive" });
      },
    },
  });

  const urls = useMemo(() => parseUrls(input), [input]);
  const canStart = urls.length >= 2 && urls.length <= MAX_URLS && !activeRun;

  // The list endpoint omits results (it's polled while a run is active), so
  // fetch the selected run's full payload separately.
  const detailQ = useGetSimilarityRun(selectedRun?.id ?? 0, {
    query: {
      queryKey: getGetSimilarityRunQueryKey(selectedRun?.id ?? 0),
      enabled: selectedRun !== null,
      staleTime: Infinity,
    },
  });
  const results = detailQ.data?.results ?? null;
  const articleByUrl = useMemo(() => {
    const m = new Map<string, SimilarityArticle>();
    for (const a of results?.articles ?? []) m.set(a.url, a);
    return m;
  }, [results]);
  const clusterOfUrl = useMemo(() => {
    const m = new Map<string, number>();
    (results?.clusters ?? []).forEach((c, ci) => {
      for (const u of c.memberUrls) m.set(u, ci);
    });
    return m;
  }, [results]);
  const failedArticles = (results?.articles ?? []).filter((a) => a.error !== null);
  const okArticles = (results?.articles ?? []).filter((a) => a.error === null);

  return (
    <div className="space-y-6" data-testid="page-similarity-explorer">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <GitCompareArrows className="h-6 w-6" />
          Similarity Explorer
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste up to {MAX_URLS} article URLs (one per line). Each article is fetched and
          compared: topics, main theme, pairwise cosine similarity, and topic clusters.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Analyze URLs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"https://example.com/first-article\nhttps://example.com/second-article"}
            rows={8}
            className="font-mono text-xs"
            disabled={!!activeRun}
            data-testid="input-similarity-urls"
          />
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span
              className={`text-xs ${urls.length > MAX_URLS ? "text-destructive" : "text-muted-foreground"}`}
            >
              {urls.length} URL{urls.length === 1 ? "" : "s"}
              {urls.length > MAX_URLS ? ` — limit is ${MAX_URLS}` : ""}
              {urls.length === 1 ? " — need at least 2" : ""}
            </span>
            <Button
              onClick={() => startMutation.mutate({ data: { urls } })}
              disabled={!canStart || startMutation.isPending}
              data-testid="button-start-analysis"
            >
              {startMutation.isPending ? (
                <Spinner className="h-4 w-4 mr-2" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Analyze
            </Button>
          </div>
        </CardContent>
      </Card>

      {activeRun && (
        <Card data-testid="card-active-run">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              <span>
                {activeRun.status === "queued"
                  ? "Queued — starting analysis…"
                  : `Analyzing articles… ${activeRun.progressDone} of ${activeRun.progressTotal}`}
              </span>
            </div>
            <Progress
              value={
                activeRun.progressTotal > 0
                  ? (activeRun.progressDone / activeRun.progressTotal) * 100
                  : 0
              }
            />
            <p className="text-xs text-muted-foreground">
              Each URL is fetched, embedded, and summarized — this usually takes a few
              seconds per article.
            </p>
          </CardContent>
        </Card>
      )}

      {failedLatest && (
        <Card className="border-destructive/50" data-testid="card-failed-run">
          <CardContent className="pt-6 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                Last analysis {failedLatest.status === "interrupted" ? "was interrupted" : "failed"}
              </p>
              {failedLatest.error && (
                <p className="text-muted-foreground mt-1">{failedLatest.error}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {completeRuns.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Showing run:</span>
          <Select
            value={String(selectedRun?.id ?? "")}
            onValueChange={(v) => setSelectedRunId(Number(v))}
          >
            <SelectTrigger className="w-[280px]" data-testid="select-run">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {completeRuns.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {runLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {results && (
        <>
          <Card data-testid="card-clusters">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Topic Clusters
              </CardTitle>
            </CardHeader>
            <CardContent>
              {results.clusters.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No clusters found — none of the analyzed articles were similar enough to
                  group together.
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {results.clusters.map((c, ci) => (
                    <div
                      key={ci}
                      className="rounded-lg border p-3 space-y-2"
                      data-testid={`cluster-${ci}`}
                    >
                      <Badge
                        variant="outline"
                        className={
                          c.label === "Unclustered"
                            ? "bg-slate-100 text-slate-700 border-slate-200"
                            : CLUSTER_COLORS[ci % CLUSTER_COLORS.length]
                        }
                      >
                        {c.label} · {c.memberUrls.length}
                      </Badge>
                      <ul className="space-y-1">
                        {c.memberUrls.map((u) => {
                          const a = articleByUrl.get(u);
                          return (
                            <li key={u} className="text-sm truncate">
                              <a
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline text-foreground/90"
                              >
                                {a ? displayName(a) : u}
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {failedArticles.length > 0 && (
            <Card className="border-amber-300/60" data-testid="card-failed-articles">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {failedArticles.length} URL{failedArticles.length > 1 ? "s" : ""} could not
                  be analyzed
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {failedArticles.map((a) => (
                    <li key={a.url} className="text-sm">
                      <span className="font-mono text-xs break-all">{a.url}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">{a.error}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {okArticles.map((a) => {
              const ci = clusterOfUrl.get(a.url);
              return (
                <Card key={a.url} data-testid={`article-card`}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm leading-snug">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline inline-flex items-start gap-1"
                        >
                          {displayName(a)}
                          <ExternalLink className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                        </a>
                      </CardTitle>
                      {ci !== undefined && results.clusters[ci] && (
                        <Badge
                          variant="outline"
                          className={`shrink-0 ${
                            results.clusters[ci].label === "Unclustered"
                              ? "bg-slate-100 text-slate-700 border-slate-200"
                              : CLUSTER_COLORS[ci % CLUSTER_COLORS.length]
                          }`}
                        >
                          {results.clusters[ci].label}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate">{a.url}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {a.topics.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {a.topics.map((t) => (
                          <Badge key={t} variant="secondary" className="text-xs font-normal">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {a.mainTheme && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground">Main theme:</span>{" "}
                        {a.mainTheme}
                      </p>
                    )}
                    <div>
                      <p className="text-xs font-medium mb-1.5">Similar articles</p>
                      {a.similar.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No similar articles above 35%.
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {a.similar.map((s) => (
                            <li
                              key={s.url}
                              className="flex items-center gap-3 text-xs"
                            >
                              <span className="flex-1 truncate" title={s.title ?? s.url}>
                                {displayName(s)}
                              </span>
                              <SimBar sim={s.sim} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {!selectedRun && !activeRun && !failedLatest && !runsQ.isLoading && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No analyses yet. Paste at least 2 article URLs above and click Analyze to see
            how your content relates.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
