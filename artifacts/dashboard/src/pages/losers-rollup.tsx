import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ToastAction } from "@/components/ui/toast";
import {
  useGetLoserWeeks,
  useGetLoserPages,
  getGetLoserPagesQueryKey,
  useListWatchlist,
  useAddWatchlistQuery,
  useDeleteWatchlistQuery,
  getListWatchlistQueryKey,
  useListPageKeywords,
  useAddPageKeyword,
  useDeletePageKeyword,
  getListPageKeywordsQueryKey,
  useAddOptimizeQueueItem,
  type LoserPage,
  type LoserPageQuery,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { HowThisWorks } from "@/components/how-this-works";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { QueryInsightsPanel } from "@/components/query-insights-panel";
import {
  TrendingDown,
  Send,
  ExternalLink,
  Star,
  Target,
  Eye,
  Trash2,
  Plus,
  CalendarClock,
  AlertTriangle,
  X,
} from "lucide-react";

function fmtPos(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toFixed(1);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${Number(n).toFixed(1)}%`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function pagePriority(p: LoserPage): "high" | "medium" | "low" {
  if (p.counts.critical > 0 || p.counts.high > 0) return "high";
  if (p.counts.medium > 0) return "medium";
  return "low";
}

function SeverityChips({ counts }: { counts: LoserPage["counts"] }) {
  const chips: { label: string; n: number; cls: string }[] = [
    { label: "Critical", n: counts.critical, cls: "text-red-600 border-red-300 bg-red-50" },
    { label: "High", n: counts.high, cls: "text-amber-600 border-amber-300 bg-amber-50" },
    { label: "Medium", n: counts.medium, cls: "text-yellow-700 border-yellow-300 bg-yellow-50" },
    { label: "Low", n: counts.low, cls: "text-muted-foreground border-border" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips
        .filter((c) => c.n > 0)
        .map((c) => (
          <Badge key={c.label} variant="outline" className={`text-xs font-mono ${c.cls}`}>
            {c.n} {c.label.toLowerCase()}
          </Badge>
        ))}
    </div>
  );
}

interface TargetKeywordEditorProps {
  url: string;
}

function TargetKeywordEditor({ url }: TargetKeywordEditorProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const { data: keywords, isLoading } = useListPageKeywords(
    { url },
    {
      query: {
        enabled: !!url,
        queryKey: getListPageKeywordsQueryKey({ url }),
      },
    },
  );
  const addKeyword = useAddPageKeyword();
  const deleteKeyword = useDeletePageKeyword();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPageKeywordsQueryKey({ url }) });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const keyword = draft.trim();
    if (!keyword) return;
    addKeyword.mutate(
      { data: { url, keyword } },
      {
        onSuccess: () => {
          setDraft("");
          invalidate();
          queryClient.invalidateQueries({ queryKey: getGetLoserPagesQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Failed to add target keyword" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteKeyword.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          queryClient.invalidateQueries({ queryKey: getGetLoserPagesQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Failed to remove target keyword" }),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Target className="h-4 w-4 text-primary" />
        Operator target keywords
        <InfoTip>
          Keywords you want this page to own. The first one becomes the canonical
          primary query when this page is sent to the Optimizer, overriding the
          highest-impression GSC pick.
        </InfoTip>
      </div>
      <form onSubmit={handleAdd} className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. ai citation tracking"
          maxLength={200}
          className="h-9"
        />
        <Button type="submit" size="sm" disabled={addKeyword.isPending || !draft.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </form>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Loading…
        </div>
      ) : !keywords || keywords.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No target keywords yet. Add the queries you want this page to win.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {keywords.map((k) => (
            <span
              key={k.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs"
            >
              {k.keyword}
              <button
                onClick={() => handleDelete(k.id)}
                className="text-muted-foreground hover:text-red-500"
                aria-label={`Remove ${k.keyword}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function WatchlistManager() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const { data: watchlist, isLoading } = useListWatchlist();
  const addQuery = useAddWatchlistQuery();
  const deleteQuery = useDeleteWatchlistQuery();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListWatchlistQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLoserPagesQueryKey() });
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const query = draft.trim();
    if (!query) return;
    addQuery.mutate(
      { data: { query } },
      {
        onSuccess: () => {
          setDraft("");
          invalidate();
        },
        onError: () => toast({ variant: "destructive", title: "Failed to add to watchlist" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteQuery.mutate(
      { id },
      {
        onSuccess: invalidate,
        onError: () => toast({ variant: "destructive", title: "Failed to remove from watchlist" }),
      },
    );
  };

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" />
          Watchlist
          <InfoTip>
            Queries you want to keep an eye on. When a watchlisted query slips
            into a page's losers, that page is flagged and sorted to the top.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a query to watch…"
            maxLength={200}
            className="h-9"
          />
          <Button type="submit" size="sm" disabled={addQuery.isPending || !draft.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </form>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : !watchlist || watchlist.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing on the watchlist yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {watchlist.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-800"
              >
                {w.query}
                <button
                  onClick={() => handleDelete(w.id)}
                  className="text-amber-500 hover:text-red-500"
                  aria-label={`Remove ${w.query}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PageQueryRowProps {
  q: LoserPageQuery;
  onInspect: (query: string) => void;
  active: boolean;
}

function PageQueryRow({ q, onInspect, active }: PageQueryRowProps) {
  return (
    <button
      onClick={() => onInspect(q.query)}
      className={`w-full text-left rounded border p-2.5 transition-colors ${
        active ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/60 hover:bg-muted/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <div className="font-medium text-sm truncate flex items-center gap-1.5">
          {q.watchlisted && <Star className="h-3 w-3 text-amber-500 shrink-0" />}
          "{q.query}"
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 capitalize text-xs ${
            q.severity === "critical"
              ? "text-red-600 border-red-300"
              : q.severity === "high"
                ? "text-amber-600 border-amber-300"
                : ""
          }`}
        >
          {q.severity}
        </Badge>
      </div>
      <div className="flex items-center gap-4 text-xs mt-1.5">
        <span className="text-muted-foreground">
          Pos&nbsp;
          <span className="font-mono text-foreground">
            {fmtPos(q.prevPosition)} → {fmtPos(q.currPosition)}
          </span>
          <span className={`ml-1 ${(q.positionChange ?? 0) > 0 ? "text-red-500" : "text-green-600"}`}>
            ({q.positionChange == null ? "—" : `${q.positionChange > 0 ? "+" : ""}${q.positionChange.toFixed(1)}`})
          </span>
        </span>
        <span className="text-muted-foreground">
          Impr&nbsp;
          <span className="font-mono text-foreground">
            {q.prevImpressions ?? 0} → {q.currImpressions ?? 0}
          </span>
          <span className={`ml-1 ${(q.impressionsChangePct ?? 0) < 0 ? "text-red-500" : "text-green-600"}`}>
            ({fmtPct(q.impressionsChangePct)})
          </span>
        </span>
        <span className="ml-auto text-primary inline-flex items-center gap-1">
          <Eye className="h-3 w-3" /> Insights
        </span>
      </div>
    </button>
  );
}

export default function LosersRollup() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [week, setWeek] = useState<string>("");
  const [selected, setSelected] = useState<LoserPage | null>(null);
  const [inspectQuery, setInspectQuery] = useState<string>("");

  const { data: weeks, isLoading: weeksLoading } = useGetLoserWeeks();

  // Resolve the effective week: explicit selection, else latest available.
  const effectiveWeek = week || weeks?.[0]?.weekOf || "";
  const params = week ? { weekOf: week } : undefined;
  const { data: rollup, isLoading: rollupLoading, isFetching } = useGetLoserPages(params, {
    query: { queryKey: getGetLoserPagesQueryKey(params) },
  });

  const addOptimize = useAddOptimizeQueueItem();

  const pages = rollup?.pages ?? [];
  const totals = useMemo(() => {
    let critical = 0;
    let high = 0;
    let queries = 0;
    let watchPages = 0;
    for (const p of pages) {
      critical += p.counts.critical;
      high += p.counts.high;
      queries += p.queryCount;
      if (p.watchlistMatch) watchPages++;
    }
    return { critical, high, queries, watchPages, pages: pages.length };
  }, [pages]);

  const handleSendPage = (p: LoserPage) => {
    const priority = pagePriority(p);
    const notes = `Page loser rollup (${effectiveWeek || "latest"}): ${p.counts.critical} critical / ${p.counts.high} high / ${p.queryCount} total slipping queries.`;
    addOptimize.mutate(
      { data: { url: p.url, priority, notes } },
      {
        onSuccess: () =>
          toast({
            title: "Sent to Optimizer",
            description: p.url,
            action: (
              <ToastAction altText="Open Optimizer" onClick={() => setLocation("/optimize")}>
                Open Optimizer
              </ToastAction>
            ),
          }),
        onError: () => toast({ variant: "destructive", title: "Failed to send to Optimizer" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-primary tracking-wide flex items-center gap-2">
            <TrendingDown className="h-7 w-7" />
            Query Losers
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pages losing ground in Search Console, one week at a time — ranked by impact.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <Select value={effectiveWeek} onValueChange={(v) => setWeek(v)}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder={weeksLoading ? "Loading weeks…" : "Select a week"} />
            </SelectTrigger>
            <SelectContent>
              {(weeks ?? []).map((w) => (
                <SelectItem key={w.weekOf} value={w.weekOf}>
                  Week of {w.weekOf} · {fmtNum(w.pageCount)} pages
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <HowThisWorks
        summary="A page-first, action-ordered view of the queries each page is losing in a given week."
        steps={[
          {
            title: "Pick a week",
            body: "Each weekly snapshot compares Search Console positions against the prior period. Pages are rolled up so you act per page, not per isolated query.",
          },
          {
            title: "Work the top of the list",
            body: "Pages are sorted watchlist-first, then by critical/high count, then by impressions lost — so the biggest problems are always on top.",
          },
          {
            title: "Open a page to dig in",
            body: "The drawer shows every slipping query for that page, lets you set operator target keywords, and gives a one-click insight panel per query.",
          },
          {
            title: "Send to the Optimizer",
            body: "Sending a page queues an AI optimization brief. Your target keywords feed straight into that brief as the canonical primary query.",
          },
        ]}
        tips={[
          "Add queries to the Watchlist to force any page they appear on to the top of the list.",
          "Target keywords are per-page and persist across weeks.",
        ]}
      />

      <WatchlistManager />

      {/* Summary strip */}
      {effectiveWeek && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-md border border-border/60 bg-card p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Pages slipping</div>
            <div className="text-2xl font-display mt-1">{fmtNum(totals.pages)}</div>
          </div>
          <div className="rounded-md border border-border/60 bg-card p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Slipping queries</div>
            <div className="text-2xl font-display mt-1">{fmtNum(totals.queries)}</div>
          </div>
          <div className="rounded-md border border-red-200 bg-red-50/50 p-3">
            <div className="text-[11px] uppercase tracking-wider text-red-600">Critical</div>
            <div className="text-2xl font-display mt-1 text-red-600">{fmtNum(totals.critical)}</div>
          </div>
          <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
            <div className="text-[11px] uppercase tracking-wider text-amber-600 flex items-center gap-1">
              <Star className="h-3 w-3" /> Watchlist hits
            </div>
            <div className="text-2xl font-display mt-1 text-amber-600">{fmtNum(totals.watchPages)}</div>
          </div>
        </div>
      )}

      {/* Page rollup list */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              Pages losing ground
              {isFetching && <Spinner className="h-4 w-4" />}
            </CardTitle>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["URL", "Impr lost"],
                  pages.map((p) => [p.url, p.impressionsLost]),
                )
              }
              disabled={pages.length === 0}
            />
          </div>
        </CardHeader>
        <CardContent>
          {rollupLoading ? (
            <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" /> Loading rollup…
            </div>
          ) : pages.length === 0 ? (
            <div className="text-sm text-muted-foreground py-10 text-center">
              No losing pages for this week. {weeks && weeks.length === 0 ? "Run the GSC losers job to populate data." : "Try another week."}
            </div>
          ) : (
            <div className="space-y-2">
              {pages.map((p) => (
                <div
                  key={p.url}
                  className={`rounded-lg border p-3 transition-colors ${
                    p.watchlistMatch ? "border-amber-300 bg-amber-50/30" : "border-border/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {p.watchlistMatch && (
                          <Badge variant="outline" className="text-xs text-amber-700 border-amber-300 bg-amber-100 gap-1">
                            <Star className="h-3 w-3" /> watchlist
                          </Badge>
                        )}
                        {p.targetKeywordCount > 0 && (
                          <Badge variant="outline" className="text-xs text-primary border-primary/40 gap-1">
                            <Target className="h-3 w-3" /> {p.targetKeywordCount} target
                          </Badge>
                        )}
                      </div>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-mono text-primary hover:underline inline-flex items-center gap-1 break-all"
                        title={p.url}
                      >
                        {p.url}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                      <div className="mt-2">
                        <SeverityChips counts={p.counts} />
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Impr lost</div>
                        <div className="font-mono text-lg text-red-600">−{fmtNum(p.impressionsLost)}</div>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        worst drop {p.worstPositionDrop == null ? "—" : `+${p.worstPositionDrop.toFixed(1)}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-border/50">
                    <span className="text-xs text-muted-foreground">{p.queryCount} slipping queries</span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelected(p);
                          setInspectQuery("");
                        }}
                      >
                        <Eye className="h-4 w-4" /> Open
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleSendPage(p)}
                        disabled={addOptimize.isPending}
                      >
                        <Send className="h-4 w-4" /> Send to Optimizer
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Page detail drawer */}
      <Drawer open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DrawerContent className="h-[88vh]">
          <div className="max-w-5xl w-full mx-auto flex flex-col h-full">
            {!selected ? null : (
              <>
                <DrawerHeader className="border-b pb-4 px-6 shrink-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <DrawerTitle className="font-display tracking-wide text-xl text-primary break-all">
                        {selected.url}
                      </DrawerTitle>
                      <DrawerDescription className="mt-1">
                        {selected.queryCount} slipping queries · −{fmtNum(selected.impressionsLost)} impressions this week
                      </DrawerDescription>
                    </div>
                    <Button
                      onClick={() => handleSendPage(selected)}
                      disabled={addOptimize.isPending}
                      className="shrink-0"
                    >
                      <Send className="h-4 w-4" /> Send to Optimizer
                    </Button>
                  </div>
                </DrawerHeader>
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                  <TargetKeywordEditor url={selected.url} />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <TrendingDown className="h-4 w-4 text-red-500" />
                        Slipping queries ({selected.queries.length})
                        <InfoTip>Click any query to load a full 28-day performance + AI strategy panel below.</InfoTip>
                      </div>
                      <CopyButton
                        getText={() =>
                          rowsToTsv(
                            [
                              "Query",
                              "Severity",
                              "Prev Pos",
                              "Curr Pos",
                              "Pos Δ",
                              "Prev Impr",
                              "Curr Impr",
                              "Impr Δ%",
                            ],
                            selected.queries.map((q) => [
                              q.query,
                              q.severity,
                              q.prevPosition ?? "",
                              q.currPosition ?? "",
                              q.positionChange ?? "",
                              q.prevImpressions ?? 0,
                              q.currImpressions ?? 0,
                              q.impressionsChangePct ?? "",
                            ]),
                          )
                        }
                        disabled={selected.queries.length === 0}
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {selected.queries.map((q) => (
                        <PageQueryRow
                          key={q.id}
                          q={q}
                          active={inspectQuery === q.query}
                          onInspect={setInspectQuery}
                        />
                      ))}
                    </div>
                  </div>

                  {inspectQuery && <QueryInsightsPanel filter={inspectQuery} />}
                </div>
              </>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
