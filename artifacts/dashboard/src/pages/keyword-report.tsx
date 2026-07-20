import { useMemo, useState } from "react";
import {
  useGetKeywordReport,
  getGetKeywordReportQueryKey,
  type GetKeywordReportParams,
} from "@workspace/api-client-react";
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
  DayTable,
  MetricCard,
  TrendChart,
  fmtPos,
  RANGE_OPTIONS,
  COUNTRY_OPTIONS,
} from "@/components/perf-blocks";
import { Globe, Search, SearchCheck } from "lucide-react";

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) return `https://${t}`;
  return t;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function KeywordReport() {
  const [urlDraft, setUrlDraft] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");
  const [days, setDays] = useState("28");
  const [country, setCountry] = useState("all");
  const [submitted, setSubmitted] = useState<{ url: string; keyword: string } | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);

  const params: GetKeywordReportParams | null = useMemo(
    () =>
      submitted
        ? {
            url: submitted.url,
            keyword: submitted.keyword,
            days: Number(days),
            ...(country !== "all" ? { country } : {}),
          }
        : null,
    [submitted, days, country],
  );

  const reportQ = useGetKeywordReport(params ?? { url: "", keyword: "" }, {
    query: {
      queryKey: getGetKeywordReportQueryKey(params ?? { url: "", keyword: "" }),
      enabled: params != null,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(urlDraft);
    const keyword = keywordDraft.trim();
    if (!url || !isValidHttpUrl(url)) {
      setFormError("Enter a valid page URL, e.g. https://wellows.com/features/prompt-tracking/");
      return;
    }
    if (!keyword) {
      setFormError("Enter the keyword you want to check for this page.");
      return;
    }
    setFormError(null);
    setSubmitted({ url, keyword });
  };

  const d = reportQ.data;
  const keywordShare =
    d && d.totals && d.pageTotals && d.pageTotals.impressions > 0
      ? (d.totals.impressions / d.pageTotals.impressions) * 100
      : null;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold flex items-center gap-2">
          <SearchCheck className="h-5 w-5 text-primary" />
          Keyword Report
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Check how any page performs for a specific keyword — daily impressions,
          clicks, and position straight from Google Search Console. Nothing is
          crawled or saved; this is a read-only lookup.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border/60 bg-card p-4 space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="kr-url">
              Page URL
            </label>
            <Input
              id="kr-url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://wellows.com/features/prompt-tracking/"
              className="mt-1"
            />
          </div>
          <div>
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="kr-keyword"
            >
              Keyword
            </label>
            <Input
              id="kr-keyword"
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              placeholder="prompt tracking"
              className="mt-1"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
          <Button type="submit" size="sm" disabled={reportQ.isFetching}>
            {reportQ.isFetching ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Get report
          </Button>
        </div>
        {formError && <div className="text-xs text-red-600 dark:text-red-400">{formError}</div>}
      </form>

      {!submitted ? null : reportQ.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : reportQ.isError ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Couldn't load Search Console data. Check the URL belongs to your site and
          try again in a moment.
        </div>
      ) : d ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="gap-1 max-w-[22rem] truncate">
              <Search className="h-3 w-3" /> {d.keyword}
            </Badge>
            <span className="text-xs text-muted-foreground break-all">{d.url}</span>
          </div>

          {!d.totals && (
            <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              Google hasn't recorded any searches for this exact keyword on this
              page in this range, so the numbers below are 0.
              {d.pageTotals
                ? ` The page overall had ${d.pageTotals.impressions.toLocaleString()} impressions in the same range.`
                : " The page itself also has no Search Console data in this range — double-check the URL."}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <MetricCard
              label="Impressions"
              value={(d.totals?.impressions ?? 0).toLocaleString()}
              totals={d.totals}
              prev={d.prevTotals}
              metric="impressions"
            />
            <MetricCard
              label="Clicks"
              value={(d.totals?.clicks ?? 0).toLocaleString()}
              totals={d.totals}
              prev={d.prevTotals}
              metric="clicks"
            />
            <MetricCard
              label="Avg position"
              value={fmtPos(d.totals?.position ?? 0)}
              totals={d.totals}
              prev={d.prevTotals}
              metric="position"
            />
          </div>

          {keywordShare != null && (
            <div className="text-xs text-muted-foreground">
              This keyword accounts for {keywordShare.toFixed(1)}% of the page's
              impressions in this range.
            </div>
          )}

          <DayTable series={d.series} title="Day-wise report (keyword)" />

          <TrendChart
            series={d.series}
            title="Day-by-day: keyword position, impressions & clicks"
          />

          <div className="text-[11px] text-muted-foreground">
            {d.startDate} → {d.endDate}
            {country !== "all" && (
              <>
                {" "}· {COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? country} only
              </>
            )}{" "}
            · All numbers come directly from Google Search Console (data lags ~2
            days) · shifts compare against the preceding {days}-day window · cached
            30 min
          </div>
        </div>
      ) : null}
    </div>
  );
}
