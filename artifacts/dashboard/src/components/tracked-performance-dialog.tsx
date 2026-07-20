import { useMemo, useState } from "react";
import {
  useGetTrackedSubmissionPerformance,
  getGetTrackedSubmissionPerformanceQueryKey,
  useUpdateTrackedSubmission,
  getListTrackedSubmissionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Search,
  Target,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  DayTable,
  MetricCard,
  TrendChart,
  fmtPos,
  RANGE_OPTIONS,
  COUNTRY_OPTIONS,
} from "@/components/perf-blocks";

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

export function TrackedPerformanceDialog({
  trackedId,
  url,
  keyword,
  open,
  onOpenChange,
}: {
  trackedId: number;
  url: string;
  keyword: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [days, setDays] = useState("28");
  const [country, setCountry] = useState("all");
  const [showDetails, setShowDetails] = useState(false);
  // The prop is a snapshot from the list; keep the live value locally so the
  // header updates immediately after an in-dialog save.
  const [effectiveKeyword, setEffectiveKeyword] = useState<string | null>(keyword);
  const [keywordDraft, setKeywordDraft] = useState(keyword ?? "");
  const [editingKeyword, setEditingKeyword] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateTrackedSubmission();

  const perfParams = useMemo(
    () => ({
      days: Number(days),
      ...(country !== "all" ? { country } : {}),
    }),
    [days, country],
  );

  const perfQ = useGetTrackedSubmissionPerformance(trackedId, perfParams, {
    query: {
      queryKey: getGetTrackedSubmissionPerformanceQueryKey(trackedId, perfParams),
      enabled: open,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  });

  const saveKeyword = () => {
    const next = keywordDraft.trim();
    updateMutation.mutate(
      { id: trackedId, data: { keyword: next.length > 0 ? next : null } },
      {
        onSuccess: () => {
          setEffectiveKeyword(next.length > 0 ? next : null);
          setEditingKeyword(false);
          toast({ title: next ? `Keyword set: “${next}”` : "Keyword cleared" });
          queryClient.invalidateQueries({
            queryKey: getListTrackedSubmissionsQueryKey(),
          });
          // Path-only key: invalidates every cached days-range for this URL.
          queryClient.invalidateQueries({
            queryKey: [`/api/tracked-submissions/${trackedId}/performance`],
          });
        },
        onError: () =>
          toast({ variant: "destructive", title: "Couldn't save keyword" }),
      },
    );
  };

  const d = perfQ.data;
  const trackedShare =
    d && d.keywordTotals && d.overallTotals.impressions > 0
      ? (d.keywordTotals.impressions / d.overallTotals.impressions) * 100
      : null;
  const topQuery = d && d.topQueries.length > 0 ? d.topQueries[0] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
            {pathOf(url)}
          </DialogTitle>
          <DialogDescription className="text-xs break-all">{url}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {editingKeyword || !effectiveKeyword ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveKeyword();
                }}
              >
                <Input
                  value={keywordDraft}
                  onChange={(e) => setKeywordDraft(e.target.value)}
                  placeholder="Target keyword, e.g. best ai visibility tools"
                  className="h-8 w-72 text-sm"
                />
                <Button type="submit" size="sm" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : "Save"}
                </Button>
                {effectiveKeyword && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingKeyword(false);
                      setKeywordDraft(effectiveKeyword);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </form>
            ) : (
              <>
                <Badge variant="secondary" className="gap-1 max-w-[22rem] truncate">
                  <Search className="h-3 w-3" /> {effectiveKeyword}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setKeywordDraft(effectiveKeyword);
                    setEditingKeyword(true);
                  }}
                >
                  Edit
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger className="w-44 h-8">
                <span className="inline-flex items-center gap-1.5 truncate">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-36 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {perfQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-6 w-6" />
          </div>
        ) : perfQ.isError ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Couldn't load Search Console data. Try again in a moment.
          </div>
        ) : d ? (
          <div className="space-y-5">
            {d.keyword && (
              <section>
                <div className="text-sm font-semibold mb-2">
                  Tracked keyword · “{d.keyword}”
                </div>
                {!d.keywordTotals && (
                  <div className="mb-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                    Google hasn't recorded any searches for this exact keyword
                    in this range yet, so the numbers below are 0. Whole-page
                    numbers are shown underneath for context.
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <MetricCard
                    label="Impressions"
                    value={(d.keywordTotals?.impressions ?? 0).toLocaleString()}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="impressions"
                  />
                  <MetricCard
                    label="Clicks"
                    value={(d.keywordTotals?.clicks ?? 0).toLocaleString()}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="clicks"
                  />
                  <MetricCard
                    label="Avg position"
                    value={fmtPos(d.keywordTotals?.position ?? 0)}
                    totals={d.keywordTotals}
                    prev={d.keywordPrevTotals}
                    metric="position"
                  />
                </div>
                <div className="mt-3">
                  <DayTable
                    series={d.keywordSeries}
                    title="Day-wise report (keyword)"
                  />
                </div>
                {showDetails && (
                  <div className="mt-3">
                    <TrendChart
                      series={d.keywordSeries}
                      title="Day-by-day: keyword position, impressions & clicks"
                    />
                  </div>
                )}
              </section>
            )}

            {(!d.keyword || !d.keywordTotals || showDetails) && (
            <section>
              <div className="text-sm font-semibold mb-2">
                Whole page (all queries)
                {trackedShare != null && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    tracked keyword = {trackedShare.toFixed(1)}% of page impressions
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MetricCard
                  label="Impressions"
                  value={d.overallTotals.impressions.toLocaleString()}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="impressions"
                />
                <MetricCard
                  label="Clicks"
                  value={d.overallTotals.clicks.toLocaleString()}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="clicks"
                />
                <MetricCard
                  label="Avg position"
                  value={fmtPos(d.overallTotals.position)}
                  totals={d.overallTotals}
                  prev={d.overallPrevTotals}
                  metric="position"
                />
              </div>
              {!d.keyword && (
                <>
                  <div className="mt-3">
                    <DayTable
                      series={d.overallSeries}
                      title="Day-wise report (whole page)"
                    />
                  </div>
                  {showDetails && (
                    <div className="mt-3">
                      <TrendChart
                        series={d.overallSeries}
                        title="Day-by-day: page position, impressions & clicks"
                      />
                    </div>
                  )}
                </>
              )}
            </section>
            )}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground w-fit"
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" /> Hide extra detail
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" /> More detail (trend
                  chart{d.keyword ? ", whole-page numbers" : ""}, top queries)
                </>
              )}
            </Button>

            {showDetails && (
            <section>
              <div className="text-sm font-semibold mb-2">
                Top queries for this page
                {topQuery && !topQuery.isTracked && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    top query: “{topQuery.query}”
                  </span>
                )}
              </div>
              {d.topQueries.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No query data in this range.
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
                        <th className="px-3 py-2 font-medium">Query</th>
                        <th className="px-3 py-2 font-medium text-right">Impressions</th>
                        <th className="px-3 py-2 font-medium text-right">Clicks</th>
                        <th className="px-3 py-2 font-medium text-right">CTR</th>
                        <th className="px-3 py-2 font-medium text-right">Position</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {d.topQueries.map((q) => (
                        <tr
                          key={q.query}
                          className={q.isTracked ? "bg-cyan-500/5" : undefined}
                        >
                          <td className="px-3 py-1.5">
                            <span className="inline-flex items-center gap-1.5">
                              {q.query}
                              {q.isTracked && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0 gap-0.5"
                                >
                                  <Target className="h-2.5 w-2.5" /> tracked
                                </Badge>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {q.impressions.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {q.clicks.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {(q.ctr * 100).toFixed(2)}%
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmtPos(q.position)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            )}

            <div className="text-[11px] text-muted-foreground">
              {d.startDate} → {d.endDate}
              {country !== "all" && (
                <>
                  {" "}· {COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? country} only
                </>
              )}{" "}
              · All numbers come directly from Google Search Console (data lags
              ~2 days) · shifts compare against the preceding {days}-day window
              · cached 30 min
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
