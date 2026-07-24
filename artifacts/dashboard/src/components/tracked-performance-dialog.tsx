import { useMemo, useState } from "react";
import {
  useGetTrackedSubmissionReport,
  getGetTrackedSubmissionReportQueryKey,
  useUpdateTrackedSubmission,
  getListTrackedSubmissionsQueryKey,
} from "@workspace/api-client-react";
import type {
  TrackedReport,
  TrackedAction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSearch,
  Globe,
  Search,
  Swords,
  Target,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import {
  DayTable,
  MetricCard,
  TrendChart,
  Delta,
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fmtWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const PRIORITY_META: Record<
  TrackedAction["priority"],
  { label: string; cls: string }
> = {
  do_first: {
    label: "Do first",
    cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
  },
  next: {
    label: "Next",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  },
  later: {
    label: "Later",
    cls: "bg-muted text-muted-foreground border-border",
  },
};

function SectionHeading({
  id,
  title,
  tip,
}: {
  id: string;
  title: string;
  tip: string;
}) {
  return (
    <div id={`report-${id}`} className="flex items-center gap-1.5 scroll-mt-16">
      <span className="text-sm font-semibold">{title}</span>
      <InfoTip>{tip}</InfoTip>
    </div>
  );
}

function SectionProblem({
  provider,
  status,
  connectHint,
}: {
  provider: string;
  status: "not_connected" | "error";
  connectHint?: string;
}) {
  if (status === "not_connected") {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
        {provider} isn't connected for this site yet.{" "}
        {connectHint ?? (
          <>
            Connect it on the{" "}
            <Link href="/settings" className="underline underline-offset-2">
              Settings page
            </Link>{" "}
            and this section will fill in.
          </>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-red-500/40 bg-red-500/5 px-3 py-3 text-sm text-muted-foreground">
      Couldn't load {provider} data right now. The rest of the report still
      works — try again in a few minutes.
    </div>
  );
}

function StatCard({
  label,
  value,
  tip,
  delta,
}: {
  label: string;
  value: string;
  tip: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
        {label}
        <InfoTip iconClassName="h-3 w-3">{tip}</InfoTip>
      </div>
      <div className="text-xl font-semibold tabular-nums mt-0.5">{value}</div>
      {delta != null && <div className="mt-0.5">{delta}</div>}
    </div>
  );
}

function ReportSection({
  id,
  icon: Icon,
  title,
  summary,
  about,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary: string;
  about: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <div id={`report-${id}`} className="rounded-lg border border-border/60 scroll-mt-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors rounded-lg"
            data-testid={`section-toggle-${id}`}
          >
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium whitespace-nowrap">{title}</span>
            <span className="ml-auto text-xs text-muted-foreground truncate">
              {summary}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-2 space-y-3 border-t border-border/60">
            <p className="text-xs text-muted-foreground">{about}</p>
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function FunnelStep({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2 min-w-[6.5rem]">
      <div className="text-lg font-semibold tabular-nums leading-tight">
        {value != null ? value.toLocaleString() : "—"}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function SnapshotOverview({
  d,
  days,
  onOpenSection,
}: {
  d: TrackedReport;
  days: string;
  onOpenSection: (id: string) => void;
}) {
  const gsc = d.gsc.status === "ok" ? d.gsc.data : null;
  const bing =
    d.bing.status === "ok" && d.bing.data && d.bing.data.weeks.length > 0
      ? d.bing.data
      : null;
  const ga4 = d.ga4.status === "ok" ? d.ga4.data : null;
  const idx = d.indexing.status === "ok" ? d.indexing.data : null;
  const ai =
    d.aiCitations.status === "ok" && d.aiCitations.data?.hasUpload
      ? d.aiCitations.data
      : null;

  const gClicks = gsc ? gsc.overallTotals.clicks : null;
  const visits = ga4 ? ga4.totals.sessions : null;
  const conversions = ga4 ? ga4.totals.keyEvents : null;
  const aiVisits = ga4 ? ga4.totals.aiSessions : null;
  const sharePct =
    gClicks != null && visits != null && visits > 0
      ? Math.min(100, Math.round((gClicks / visits) * 100))
      : null;

  const num = (v: number | null | undefined, fmt?: (n: number) => string) => (
    <td className="px-2 py-1 text-right tabular-nums">
      {v != null ? (fmt ? fmt(v) : v.toLocaleString()) : "—"}
    </td>
  );

  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="report-snapshot">
      <div className="rounded-lg border border-border/60 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs font-semibold inline-flex items-center gap-1">
            Search engines at a glance
            <InfoTip>
              The same three numbers from Google and Bing, side by side. Being
              visible on both is the overlap that matters — Bing also powers
              ChatGPT's and Copilot's web results.
            </InfoTip>
          </span>
          {idx &&
            (idx.verdict === "PASS" ? (
              <Badge
                variant="outline"
                className="gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
              >
                <CheckCircle2 className="h-3 w-3" /> Indexed on Google
              </Badge>
            ) : idx.verdict === "FAIL" ? (
              <Badge
                variant="outline"
                className="gap-1 bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
              >
                <XCircle className="h-3 w-3" /> Not indexed on Google
              </Badge>
            ) : (
              <Badge variant="outline">Indexing unclear</Badge>
            ))}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="text-left font-medium py-1"></th>
              <th className="text-right font-medium px-2 py-1">Google</th>
              <th className="text-right font-medium px-2 py-1">Bing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            <tr>
              <td className="py-1 text-xs text-muted-foreground">Times shown</td>
              {num(gsc?.overallTotals.impressions)}
              {num(bing?.totals.impressions)}
            </tr>
            <tr>
              <td className="py-1 text-xs text-muted-foreground">Clicks</td>
              {num(gsc?.overallTotals.clicks)}
              {num(bing?.totals.clicks)}
            </tr>
            <tr>
              <td className="py-1 text-xs text-muted-foreground">Avg position</td>
              {num(gsc ? gsc.overallTotals.position : null, fmtPos)}
              {num(bing ? bing.totals.position : null, fmtPos)}
            </tr>
          </tbody>
        </table>
        <p className="text-[11px] text-muted-foreground">
          Google = last {days} days · Bing = its own ~6-month window, so the
          columns aren't directly comparable.
        </p>
        <div className="flex items-center gap-1 -ml-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => onOpenSection("google")}
          >
            Google details <ArrowRight className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => onOpenSection("bing")}
          >
            Bing details <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 p-3 space-y-2">
        <span className="text-xs font-semibold inline-flex items-center gap-1">
          How search turns into visitors
          <InfoTip>
            Google clicks and Analytics visits cover the same {days}-day window,
            so they connect: most Google clicks show up inside the visits count,
            alongside visits from AI tools, social, links, and direct traffic.
            (Analytics misses some visitors — ad blockers and cookie banners —
            so the numbers won't match exactly.) Bing is left out here because
            it reports a different time window.
          </InfoTip>
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FunnelStep label="Google clicks" value={gClicks} />
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <FunnelStep label="Visits (all sources)" value={visits} />
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <FunnelStep label="Conversions" value={conversions} />
        </div>
        {sharePct != null ? (
          <p className="text-[11px] text-muted-foreground">
            The overlap: Google search accounts for roughly {sharePct}% of this
            page's visits. The rest arrive from AI tools, social, other sites,
            or people typing the address.
          </p>
        ) : d.gsc.status === "ok" && d.ga4.status === "ok" ? (
          <p className="text-[11px] text-muted-foreground">
            No visits recorded in this range yet, so there's no search-to-visits
            overlap to show. Try a longer date range.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Connect both Google Search Console and Analytics to see how much of
            this page's traffic comes from search.
          </p>
        )}
        <div className="border-t border-border/60 pt-2 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            AI: {ai ? `${ai.citations.toLocaleString()} citations` : "no upload yet"}
            {" · "}
            {aiVisits != null ? `${aiVisits.toLocaleString()} AI visits` : "AI visits —"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => onOpenSection("ga4")}
            >
              Visitor details <ArrowRight className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => onOpenSection("ai")}
            >
              AI details <ArrowRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
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
  const [showGscDetails, setShowGscDetails] = useState(false);
  // The prop is a snapshot from the list; keep the live value locally so the
  // header updates immediately after an in-dialog save.
  const [effectiveKeyword, setEffectiveKeyword] = useState<string | null>(keyword);
  const [keywordDraft, setKeywordDraft] = useState(keyword ?? "");
  const [editingKeyword, setEditingKeyword] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateTrackedSubmission();

  const reportParams = useMemo(
    () => ({
      days: Number(days),
      ...(country !== "all" ? { country } : {}),
    }),
    [days, country],
  );

  const reportQ = useGetTrackedSubmissionReport(trackedId, reportParams, {
    query: {
      queryKey: getGetTrackedSubmissionReportQueryKey(trackedId, reportParams),
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
            queryKey: [`/api/tracked-submissions/${trackedId}/report`],
          });
        },
        onError: () =>
          toast({ variant: "destructive", title: "Couldn't save keyword" }),
      },
    );
  };

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const toggleSection = (id: string) =>
    setOpenSections((s) => ({ ...s, [id]: !s[id] }));
  const openSection = (id: string) => {
    setOpenSections((s) => ({ ...s, [id]: true }));
    setTimeout(() => {
      document
        .getElementById(`report-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const d: TrackedReport | undefined = reportQ.data;
  const gsc = d?.gsc.data ?? null;
  const trackedShare =
    gsc && gsc.keywordTotals && gsc.overallTotals.impressions > 0
      ? (gsc.keywordTotals.impressions / gsc.overallTotals.impressions) * 100
      : null;

  // One-line summaries shown on the collapsed section headers.
  const srcSummary = (
    status: "ok" | "not_connected" | "error" | undefined,
    ok: string | null,
  ) =>
    status === "not_connected"
      ? "Not connected"
      : status === "error"
        ? "Unavailable"
        : (ok ?? "No data yet");

  const idxData = d?.indexing.status === "ok" ? d.indexing.data : null;
  const bingData = d?.bing.status === "ok" ? d.bing.data : null;
  const ga4Data = d?.ga4.status === "ok" ? d.ga4.data : null;
  const aiData = d?.aiCitations.status === "ok" ? d.aiCitations.data : null;

  const googleSummary = srcSummary(
    d?.gsc.status,
    gsc
      ? `${gsc.overallTotals.impressions.toLocaleString()} shown · ${gsc.overallTotals.clicks.toLocaleString()} clicks · pos ${fmtPos(gsc.overallTotals.position)}`
      : null,
  );
  const indexingSummary = srcSummary(
    d?.indexing.status,
    idxData
      ? idxData.verdict === "PASS"
        ? "Yes — indexed"
        : idxData.verdict === "FAIL"
          ? "No — not indexed"
          : "Unclear"
      : null,
  );
  const bingSummary = srcSummary(
    d?.bing.status,
    bingData
      ? bingData.weeks.length === 0
        ? "No Bing data yet"
        : `${bingData.totals.impressions.toLocaleString()} shown · ${bingData.totals.clicks.toLocaleString()} clicks${
            bingData.totals.position != null
              ? ` · pos ${fmtPos(bingData.totals.position)}`
              : ""
          }`
      : null,
  );
  const ga4Summary = srcSummary(
    d?.ga4.status,
    ga4Data
      ? `${ga4Data.totals.sessions.toLocaleString()} visits · ${ga4Data.totals.keyEvents.toLocaleString()} conversions`
      : null,
  );
  const aiSummary =
    d?.aiCitations.status !== "ok"
      ? "Unavailable"
      : aiData?.hasUpload
        ? `${aiData.citations.toLocaleString()} citations`
        : "No upload yet";
  const ownRank =
    d?.serpCompetitors?.competitors.find((c) => c.isOwn)?.position ?? null;
  const compSummary = !d?.keyword
    ? "Set a keyword first"
    : d.serpCompetitors == null
      ? "No stored results yet"
      : ownRank != null
        ? `You're #${ownRank}`
        : `You're not in the top ${d.serpCompetitors.competitors.length}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto">
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

        <HowThisWorks
          summary="One page pulls everything we know about this URL together: Google numbers, whether Google can even show the page, Bing numbers, real visitors, AI mentions, and who you're up against — then turns it into a to-do list."
          steps={[
            {
              title: "We fetch each data source separately",
              body: "Google Search Console, indexing status, Bing, Google Analytics, and your uploaded AI-citation reports. If one source is down or not connected, the rest still load.",
            },
            {
              title: "The action plan is computed from the numbers",
              body: "Simple, transparent rules — nothing is sent to an AI and nothing costs money. Every card explains why it appeared.",
            },
            {
              title: "The date range applies to Google and Analytics",
              body: "Bing only reports weekly totals over roughly the last 6 months, and AI citations come from your latest upload, so those two show their own time windows.",
            },
          ]}
        />

        {reportQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-6 w-6" />
          </div>
        ) : reportQ.isError ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Couldn't load the report. Try again in a moment.
          </div>
        ) : d ? (
          <div className="space-y-4">
            {/* ---------- 0. At a glance ---------- */}
            <SnapshotOverview d={d} days={days} onOpenSection={openSection} />

            {/* ---------- 1. Action plan ---------- */}
            <section className="space-y-2">
              <SectionHeading
                id="plan"
                title="Action plan"
                tip="A prioritized to-do list computed from the numbers below with simple rules. 'Do first' items block or waste the most traffic; 'Later' items are nice-to-haves."
              />
              {d.actionPlan.length === 0 ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3 text-sm text-muted-foreground inline-flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Nothing urgent found — this page looks healthy for the data we
                  have. Check back after the next data sync.
                </div>
              ) : (
                <div className="space-y-2">
                  {d.actionPlan.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-lg border border-border/60 p-3"
                      data-testid={`action-${a.id}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 ${PRIORITY_META[a.priority].cls}`}
                        >
                          {PRIORITY_META[a.priority].label}
                        </Badge>
                        <span className="text-sm font-medium">{a.title}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{a.why}</p>
                      {a.steps.length > 0 && (
                        <ol className="mt-2 space-y-1 text-xs text-muted-foreground list-decimal list-inside">
                          {a.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      )}
                      {a.link && (
                        <Link
                          href={a.link}
                          className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-700 dark:text-cyan-400 underline underline-offset-2"
                          onClick={() => onOpenChange(false)}
                        >
                          {a.linkLabel ?? "Open"} <ArrowRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ---------- 2. Google Search ---------- */}
            <ReportSection
              id="google"
              icon={Search}
              title="Google Search"
              summary={googleSummary}
              about="Live numbers from Google Search Console. Impressions = how often the page appeared in results; clicks = how often it was chosen; position = average ranking spot (lower is better). Data lags ~2 days."
              open={!!openSections.google}
              onToggle={() => toggleSection("google")}
            >
              {d.gsc.status !== "ok" ? (
                <SectionProblem provider="Google Search Console" status={d.gsc.status} />
              ) : gsc ? (
                <>
                  {d.keyword && (
                    <div>
                      <div className="text-xs font-medium mb-2 inline-flex items-center gap-1">
                        Tracked keyword · “{d.keyword}”
                        <InfoTip>
                          Only searches for this exact keyword (word order and
                          spacing ignored). The whole-page numbers below include
                          every search the page showed up for.
                        </InfoTip>
                      </div>
                      {!gsc.keywordTotals && (
                        <div className="mb-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                          Google hasn't recorded any searches for this exact
                          keyword in this range yet, so the numbers below are 0.
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        <MetricCard
                          label="Impressions"
                          value={(gsc.keywordTotals?.impressions ?? 0).toLocaleString()}
                          totals={gsc.keywordTotals}
                          prev={gsc.keywordPrevTotals}
                          metric="impressions"
                        />
                        <MetricCard
                          label="Clicks"
                          value={(gsc.keywordTotals?.clicks ?? 0).toLocaleString()}
                          totals={gsc.keywordTotals}
                          prev={gsc.keywordPrevTotals}
                          metric="clicks"
                        />
                        <MetricCard
                          label="Avg position"
                          value={fmtPos(gsc.keywordTotals?.position ?? 0)}
                          totals={gsc.keywordTotals}
                          prev={gsc.keywordPrevTotals}
                          metric="position"
                        />
                      </div>
                      <div className="mt-3">
                        <DayTable series={gsc.keywordSeries} title="Day-wise report (keyword)" />
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-medium mb-2 inline-flex items-center gap-1">
                      Whole page (all queries)
                      {trackedShare != null && (
                        <span className="text-muted-foreground font-normal">
                          · tracked keyword = {trackedShare.toFixed(1)}% of page impressions
                        </span>
                      )}
                      <InfoTip>
                        Every Google search this page appeared for in the selected
                        range, not just the tracked keyword.
                      </InfoTip>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <MetricCard
                        label="Impressions"
                        value={gsc.overallTotals.impressions.toLocaleString()}
                        totals={gsc.overallTotals}
                        prev={gsc.overallPrevTotals}
                        metric="impressions"
                      />
                      <MetricCard
                        label="Clicks"
                        value={gsc.overallTotals.clicks.toLocaleString()}
                        totals={gsc.overallTotals}
                        prev={gsc.overallPrevTotals}
                        metric="clicks"
                      />
                      <MetricCard
                        label="Avg position"
                        value={fmtPos(gsc.overallTotals.position)}
                        totals={gsc.overallTotals}
                        prev={gsc.overallPrevTotals}
                        metric="position"
                      />
                    </div>
                    {!d.keyword && (
                      <div className="mt-3">
                        <DayTable series={gsc.overallSeries} title="Day-wise report (whole page)" />
                      </div>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs text-muted-foreground w-fit"
                    onClick={() => setShowGscDetails((v) => !v)}
                  >
                    {showGscDetails ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" /> Hide trend chart & top queries
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" /> Trend chart & top queries
                      </>
                    )}
                  </Button>

                  {showGscDetails && (
                    <>
                      <TrendChart
                        series={d.keyword && gsc.keywordTotals ? gsc.keywordSeries : gsc.overallSeries}
                        title={
                          d.keyword && gsc.keywordTotals
                            ? "Day-by-day: keyword position, impressions & clicks"
                            : "Day-by-day: page position, impressions & clicks"
                        }
                      />
                      <div>
                        <div className="text-xs font-medium mb-2 inline-flex items-center gap-1">
                          Top queries for this page
                          <InfoTip>
                            The searches that showed this page most often in the
                            selected range. The highlighted row is your tracked
                            keyword.
                          </InfoTip>
                        </div>
                        {gsc.topQueries.length === 0 ? (
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
                                {gsc.topQueries.map((q) => (
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
                      </div>
                    </>
                  )}
                </>
              ) : null}
            </ReportSection>

            {/* ---------- 3. Indexing ---------- */}
            <ReportSection
              id="indexing"
              icon={FileSearch}
              title="Can Google show this page?"
              summary={indexingSummary}
              about="Google's own URL Inspection verdict. If a page isn't indexed, it can't appear in results no matter how good it is. Checked at most once a day to protect your quota."
              open={!!openSections.indexing}
              onToggle={() => toggleSection("indexing")}
            >
              {d.indexing.status !== "ok" ? (
                <SectionProblem provider="Google Search Console" status={d.indexing.status} />
              ) : d.indexing.data ? (
                <div className="rounded-lg border border-border/60 p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {d.indexing.data.verdict === "PASS" ? (
                      <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" variant="outline">
                        <CheckCircle2 className="h-3 w-3" /> Indexed
                      </Badge>
                    ) : d.indexing.data.verdict === "FAIL" ? (
                      <Badge className="gap-1 bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30" variant="outline">
                        <XCircle className="h-3 w-3" /> Not indexed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1">
                        Unclear
                      </Badge>
                    )}
                    {d.indexing.data.coverageState && (
                      <span className="text-xs text-muted-foreground">
                        {d.indexing.data.coverageState}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-xs text-muted-foreground">
                    <div className="inline-flex items-center gap-1">
                      Robots.txt:{" "}
                      <span className="text-foreground">
                        {d.indexing.data.robotsTxtState ?? "—"}
                      </span>
                      <InfoTip iconClassName="h-3 w-3">
                        Whether your robots.txt file allows Google to visit this
                        page. "DISALLOWED" means Google is blocked from it.
                      </InfoTip>
                    </div>
                    <div className="inline-flex items-center gap-1">
                      Page fetch:{" "}
                      <span className="text-foreground">
                        {d.indexing.data.pageFetchState ?? "—"}
                      </span>
                      <InfoTip iconClassName="h-3 w-3">
                        Whether Google could load the page the last time it
                        tried. Anything other than "SUCCESSFUL" needs attention.
                      </InfoTip>
                    </div>
                    <div className="inline-flex items-center gap-1">
                      Last crawled:{" "}
                      <span className="text-foreground">
                        {fmtWhen(d.indexing.data.lastCrawlTime) ?? "never"}
                      </span>
                      <InfoTip iconClassName="h-3 w-3">
                        When Google last visited this page. Recently updated
                        pages that haven't been re-crawled won't show changes in
                        results yet.
                      </InfoTip>
                    </div>
                    <div className="inline-flex items-center gap-1">
                      Google's chosen URL:{" "}
                      <span className="text-foreground break-all">
                        {d.indexing.data.googleCanonical
                          ? d.indexing.data.googleCanonical === d.indexing.data.userCanonical ||
                            !d.indexing.data.userCanonical
                            ? "matches yours"
                            : "different from yours"
                          : "—"}
                      </span>
                      <InfoTip iconClassName="h-3 w-3">
                        When several URLs show the same content, Google picks one
                        "canonical" to rank. If Google picked a different URL
                        than you declared, this page's traffic may be credited
                        elsewhere.
                      </InfoTip>
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Checked {fmtWhen(d.indexing.data.inspectedAt) ?? "recently"} · re-checked
                    at most once a day
                  </div>
                </div>
              ) : null}
            </ReportSection>

            {/* ---------- 4. Bing ---------- */}
            <ReportSection
              id="bing"
              icon={TrendingUp}
              title="Bing search"
              summary={bingSummary}
              about="Numbers from Bing Webmaster Tools — Bing also powers ChatGPT's and Copilot's web results, so showing up here helps AI visibility too. Bing only reports weekly totals over roughly the last 6 months, so the date range above doesn't apply."
              open={!!openSections.bing}
              onToggle={() => toggleSection("bing")}
            >
              {d.bing.status !== "ok" ? (
                <SectionProblem provider="Bing Webmaster Tools" status={d.bing.status} />
              ) : d.bing.data ? (
                d.bing.data.weeks.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    Bing hasn't reported any impressions for this page in its
                    ~6-month window. If the page matters, check it's in your
                    sitemap and submitted in Bing Webmaster Tools.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <StatCard
                        label="Impressions"
                        value={d.bing.data.totals.impressions.toLocaleString()}
                        tip="How often this page appeared in Bing results over the whole ~6-month window."
                      />
                      <StatCard
                        label="Clicks"
                        value={d.bing.data.totals.clicks.toLocaleString()}
                        tip="How often searchers clicked through from Bing over the whole window."
                      />
                      <StatCard
                        label="Avg position"
                        value={
                          d.bing.data.totals.position != null
                            ? fmtPos(d.bing.data.totals.position)
                            : "—"
                        }
                        tip="Average ranking spot on Bing, weighted by impressions. Weeks where Bing didn't report a position are excluded. Lower is better."
                      />
                    </div>
                    <div className="rounded-lg border border-border/60 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
                            <th className="px-3 py-2 font-medium">Week of</th>
                            <th className="px-3 py-2 font-medium text-right">Impressions</th>
                            <th className="px-3 py-2 font-medium text-right">Clicks</th>
                            <th className="px-3 py-2 font-medium text-right">Position</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {d.bing.data.weeks
                            .slice()
                            .reverse()
                            .map((w) => (
                              <tr key={w.weekStart}>
                                <td className="px-3 py-1.5 tabular-nums">
                                  {fmtWhen(w.weekStart) ?? w.weekStart}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">
                                  {w.impressions.toLocaleString()}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">
                                  {w.clicks.toLocaleString()}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">
                                  {w.position != null ? fmtPos(w.position) : "—"}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {d.bing.data.lastSyncDate && (
                      <div className="text-[11px] text-muted-foreground">
                        Latest Bing data bucket: {fmtWhen(d.bing.data.lastSyncDate)} · synced
                        daily from Bing Webmaster Tools
                      </div>
                    )}
                  </>
                )
              ) : null}
            </ReportSection>

            {/* ---------- 5. Visitors (GA4) ---------- */}
            <ReportSection
              id="ga4"
              icon={Globe}
              title="What visitors do on this page"
              summary={ga4Summary}
              about="From Google Analytics: real people who landed on this page from any channel (search, AI tools, social, direct). Search Console counts what happens on Google; Analytics counts what happens on your site."
              open={!!openSections.ga4}
              onToggle={() => toggleSection("ga4")}
            >
              {d.ga4.status !== "ok" ? (
                <SectionProblem provider="Google Analytics 4" status={d.ga4.status} />
              ) : d.ga4.data ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatCard
                      label="Visits"
                      value={d.ga4.data.totals.sessions.toLocaleString()}
                      tip="Sessions that started on this page in the selected range — every traffic source, not just Google."
                      delta={
                        <Delta
                          current={d.ga4.data.totals.sessions}
                          previous={d.ga4.data.prevTotals?.sessions}
                        />
                      }
                    />
                    <StatCard
                      label="Engagement"
                      value={`${Math.round(d.ga4.data.totals.engagementRate * 100)}%`}
                      tip="Share of visits where the person actually engaged — stayed 10+ seconds, converted, or viewed more pages. Higher is better; below ~50% suggests the page isn't meeting expectations."
                      delta={
                        <Delta
                          current={d.ga4.data.totals.engagementRate * 100}
                          previous={
                            d.ga4.data.prevTotals != null
                              ? d.ga4.data.prevTotals.engagementRate * 100
                              : null
                          }
                          digits={1}
                        />
                      }
                    />
                    <StatCard
                      label="Conversions"
                      value={d.ga4.data.totals.keyEvents.toLocaleString()}
                      tip="Sign-ups and demo bookings from visits that started on this page — the actions that actually matter for the business."
                      delta={
                        <Delta
                          current={d.ga4.data.totals.keyEvents}
                          previous={d.ga4.data.prevTotals?.keyEvents}
                        />
                      }
                    />
                    <StatCard
                      label="AI visits"
                      value={d.ga4.data.totals.aiSessions.toLocaleString()}
                      tip="Visits referred by AI tools like ChatGPT, Perplexity, Gemini, Copilot, or Claude — people who clicked through after an AI mentioned this page."
                      delta={
                        <Delta
                          current={d.ga4.data.totals.aiSessions}
                          previous={d.ga4.data.prevTotals?.aiSessions}
                        />
                      }
                    />
                  </div>
                  {d.ga4.data.series.length > 0 && (
                    <div className="rounded-lg border border-border/60 overflow-hidden">
                      <div className="max-h-56 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-muted/95">
                            <tr className="text-left text-xs text-muted-foreground border-b">
                              <th className="px-3 py-2 font-medium">Day</th>
                              <th className="px-3 py-2 font-medium text-right">Visits</th>
                              <th className="px-3 py-2 font-medium text-right">Engaged</th>
                              <th className="px-3 py-2 font-medium text-right">Conversions</th>
                              <th className="px-3 py-2 font-medium text-right">AI visits</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {d.ga4.data.series
                              .slice()
                              .reverse()
                              .map((p) => (
                                <tr key={p.date}>
                                  <td className="px-3 py-1.5 tabular-nums">
                                    {fmtWhen(p.date) ?? p.date}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {p.sessions.toLocaleString()}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {p.engagedSessions.toLocaleString()}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {p.keyEvents.toLocaleString()}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {p.aiSessions.toLocaleString()}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </ReportSection>

            {/* ---------- 6. AI visibility ---------- */}
            <ReportSection
              id="ai"
              icon={Bot}
              title="AI visibility"
              summary={aiSummary}
              about="How often Copilot / Bing AI cited this page as a source, from your latest Bing 'AI Performance' upload. Microsoft doesn't offer an API for this report, so it only updates when you upload a fresh export on the Bing page."
              open={!!openSections.ai}
              onToggle={() => toggleSection("ai")}
            >
              {d.aiCitations.status !== "ok" ? (
                <SectionProblem provider="AI citation data" status="error" />
              ) : d.aiCitations.data ? (
                !d.aiCitations.data.hasUpload ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    No AI-citation report uploaded yet. Export the "AI
                    Performance" report from Bing Webmaster Tools and upload it
                    on the{" "}
                    <Link
                      href="/bing"
                      className="underline underline-offset-2"
                      onClick={() => onOpenChange(false)}
                    >
                      Bing &amp; AI page
                    </Link>{" "}
                    to see how often AI tools cite this page.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:max-w-md">
                      <StatCard
                        label="AI citations"
                        value={d.aiCitations.data.citations.toLocaleString()}
                        tip="Times Copilot / Bing AI used this page as a source in its answers, according to your latest upload. Zero can simply mean the page hasn't been picked up by AI answers yet."
                      />
                      <StatCard
                        label="AI visits (Analytics)"
                        value={
                          d.ga4.data ? d.ga4.data.totals.aiSessions.toLocaleString() : "—"
                        }
                        tip="Cross-check from Google Analytics: actual visitors who arrived from AI tools in the selected range. Citations without visits means AI mentions the page but people don't click through."
                      />
                    </div>
                    {d.aiCitations.data.groundingQueries.length > 0 && (
                      <div>
                        <div className="text-xs font-medium mb-2 inline-flex items-center gap-1">
                          AI questions matching your keyword
                          <InfoTip>
                            From the "grounding queries" upload: the search
                            phrases the AI used when it looked for sources. Only
                            phrases containing your tracked keyword are shown —
                            the export doesn't say which page each query led to.
                          </InfoTip>
                        </div>
                        <div className="rounded-lg border border-border/60 overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
                                <th className="px-3 py-2 font-medium">AI query</th>
                                <th className="px-3 py-2 font-medium text-right">Citations</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {d.aiCitations.data.groundingQueries.map((g) => (
                                <tr key={g.query}>
                                  <td className="px-3 py-1.5">{g.query}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {g.citations.toLocaleString()}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      From upload “{d.aiCitations.data.uploadLabel ?? "latest"}”
                      {d.aiCitations.data.uploadedAt && (
                        <> · uploaded {fmtWhen(d.aiCitations.data.uploadedAt)}</>
                      )}
                    </div>
                  </>
                )
              ) : null}
            </ReportSection>

            {/* ---------- 7. Competitors ---------- */}
            <ReportSection
              id="competitors"
              icon={Swords}
              title="Who ranks around you"
              summary={compSummary}
              about="The Google results page captured for your tracked keyword the last time keyword clustering ran. Reading stored results is free — nothing is re-fetched here."
              open={!!openSections.competitors}
              onToggle={() => toggleSection("competitors")}
            >
              {!d.keyword ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                  Set a tracked keyword above to see who ranks for it.
                </div>
              ) : d.serpCompetitors == null ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                  No stored search-results data for “{d.keyword}” yet. It appears
                  after a keyword clustering run that includes this keyword —
                  start one on the{" "}
                  <Link
                    href="/clusters"
                    className="underline underline-offset-2"
                    onClick={() => onOpenChange(false)}
                  >
                    Keyword Clusters page
                  </Link>
                  .
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-border/60 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
                          <th className="px-3 py-2 font-medium w-14">Rank</th>
                          <th className="px-3 py-2 font-medium">Page</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {d.serpCompetitors.competitors.map((c) => (
                          <tr
                            key={`${c.position}-${c.url}`}
                            className={c.isOwn ? "bg-cyan-500/5" : undefined}
                          >
                            <td className="px-3 py-1.5 tabular-nums">#{c.position}</td>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                <a
                                  href={c.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate max-w-[34rem] underline-offset-2 hover:underline"
                                  title={c.url}
                                >
                                  {hostOf(c.url)}
                                  {pathOf(c.url) !== "/" ? pathOf(c.url) : ""}
                                </a>
                                {c.isOwn && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0"
                                  >
                                    <Target className="h-2.5 w-2.5" /> you
                                  </Badge>
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Captured {fmtWhen(d.serpCompetitors.runDate) ?? "recently"} during the
                    last keyword clustering run · shown for “{d.serpCompetitors.keyword}”
                  </div>
                </>
              )}
            </ReportSection>

            <div className="text-[11px] text-muted-foreground border-t border-border/60 pt-3">
              Google &amp; Analytics range: {d.startDate} → {d.endDate}
              {country !== "all" && (
                <>
                  {" "}· {COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? country} only
                  (Google Search numbers)
                </>
              )}{" "}
              · shifts compare against the preceding {days}-day window · Bing
              shows its own ~6-month window · nothing on this report costs
              anything to load · cached 30 min
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
