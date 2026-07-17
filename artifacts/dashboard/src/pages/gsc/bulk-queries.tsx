import { useMemo, useState } from "react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDown, ChevronRight, Copy, Check, Download, ExternalLink, Play, AlertTriangle } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TIER_TOOLTIP: Record<Tier, string> = {
  off_page_one:
    "Off page 1 — average position 11–20. Highest leverage band: a small push moves the query onto page 1, often 5–10× the click gain of the same push at any other position. Priority gets a 1.5× bias.",
  striking_distance:
    "Striking distance — average position 4–10. Already on page 1 but below the top three. A content depth pass, better internal anchors, or schema usually pushes these into the top 3. Priority gets a 1.2× bias.",
  defend:
    "Defend — average position 1–3. You're already winning. Protect with freshness, internal links pointing in, and watching for cannibalization. Priority is biased down (0.7×) since the upside is small.",
  stretch:
    "Stretch — average position 21+. Needs structural work (new section, new H2, rewrite, or a brand-new page) to break onto page 2. Priority is biased down (0.5×) — only worth it on high-impression queries.",
};

const COLUMN_TIPS: Record<string, string> = {
  query: "The exact search query users typed in Google over the selected window. Pulled from Search Console at the query+page level.",
  tier: "Bucket based on average position over the window. Off page 1 → striking distance → defend → stretch, in priority order. Hover any badge for the full explanation.",
  priority:
    "Ranking score = estimated incremental clicks × tier bias. It's a relative ranker, not a forecast — the top of the list is always 'edit this one first'. Off page 1 wins float to the top because moving a query from position 12 → 5 is the biggest possible CTR jump per impression.",
  est: "Estimated incremental clicks if this query moved into a better band, using industry-average CTR curves. Formula: impressions × (target-CTR − current-CTR). Target depends on the tier: defend stays put, striking-distance targets pos 3, off-page-1 targets pos 5, stretch targets pos 10.",
  clicks: "Actual clicks for this exact query landing on this URL during the window.",
  impr: "Actual impressions — how many times your URL appeared in Google for this query.",
  ctr: "Click-through rate = clicks ÷ impressions for this query. A CTR well below the industry average for the position is itself a signal (weak title/meta, SERP feature stealing the click).",
  pos: "Average position over the window, weighted by impressions. GSC computes this — values like 8.4 mean 'most of the time it shows around 8th, occasionally higher or lower'.",
};

const BULK_URL = `${import.meta.env.BASE_URL}api/gsc/bulk-queries`.replace(/\/+api/, "/api");

type Tier = "defend" | "striking_distance" | "off_page_one" | "stretch";

interface RankedQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  tier: Tier;
  priority: number;
  estIncrementalClicks: number;
  reason: string;
}

interface UrlResult {
  url: string;
  ok: boolean;
  error?: string;
  totals?: { clicks: number; impressions: number; ctr: number; position: number };
  queries: RankedQuery[];
}

interface ApiResponse {
  range: { startDate: string; endDate: string; days: number };
  results: UrlResult[];
}

const TIER_LABEL: Record<Tier, string> = {
  off_page_one: "Off page 1",
  striking_distance: "Striking distance",
  defend: "Defend",
  stretch: "Stretch",
};

const TIER_COLOR: Record<Tier, string> = {
  off_page_one: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  striking_distance: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  defend: "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30",
  stretch: "bg-muted text-muted-foreground border-border",
};

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsvEscape(v: string | number): string {
  // Strip tabs/newlines so paste-into-sheet stays in one cell.
  return String(v).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

const HEADER = [
  "url", "query", "tier", "priority", "estIncrementalClicks",
  "clicks", "impressions", "ctr", "position", "reason",
];

function toCsv(results: UrlResult[], range: ApiResponse["range"]): string {
  const lines = [HEADER.join(",")];
  for (const r of results) {
    if (!r.ok) {
      lines.push([r.url, "", "ERROR", "", "", "", "", "", "", r.error ?? ""].map(csvEscape).join(","));
      continue;
    }
    for (const q of r.queries) {
      lines.push([
        r.url, q.query, q.tier, q.priority, q.estIncrementalClicks,
        q.clicks, q.impressions, q.ctr, q.position, q.reason,
      ].map(csvEscape).join(","));
    }
  }
  return `# Range: ${range.startDate} → ${range.endDate} (${range.days} days)\n${lines.join("\n")}`;
}

function toTsv(results: UrlResult[], onlyUrl?: string): string {
  const lines = [HEADER.join("\t")];
  for (const r of results) {
    if (onlyUrl && r.url !== onlyUrl) continue;
    if (!r.ok) continue;
    for (const q of r.queries) {
      lines.push([
        r.url, q.query, q.tier, q.priority, q.estIncrementalClicks,
        q.clicks, q.impressions, q.ctr, q.position, q.reason,
      ].map(tsvEscape).join("\t"));
    }
  }
  return lines.join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function BulkQueriesBody() {
  const [input, setInput] = useState(
    "",
  );
  const [days, setDays] = useState(28);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function copyTsv(key: string, text: string) {
    const ok = await copyToClipboard(text);
    if (!ok) {
      setError("Copy failed — your browser blocked clipboard access. Use Export CSV instead.");
      return;
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  }

  const urlList = useMemo(
    () => input.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)),
    [input],
  );

  async function run() {
    if (urlList.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(BULK_URL, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: urlList, days }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiResponse;
      setData(json);
      // auto-expand the first URL
      setExpanded(new Set(json.results[0] ? [json.results[0].url] : []));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function toggle(url: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function expandAll() {
    if (!data) return;
    setExpanded(new Set(data.results.map((r) => r.url)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  function downloadCsv() {
    if (!data) return;
    const csv = toCsv(data.results, data.range);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gsc-bulk-queries-${data.range.startDate}-to-${data.range.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-6">
      <HowThisWorks
        summary="Paste a batch of URLs and get the last-28-day GSC queries for each one, prioritized by opportunity. Striking-distance and off-page-1 queries float to the top."
        steps={[
          { title: "Paste URLs", body: "One per line. Up to 50 URLs per run. Each must be a full https:// URL that exists in your GSC property." },
          { title: "Pick window", body: "Default is 28 days (Search Console's standard window). You can extend up to 90 days." },
          { title: "Read the priority", body: "Each query gets a tier and a priority score = estimated incremental clicks × tier bias. Off-page-1 wins (positions 11–20) get the biggest bias because moving them to page 1 is the highest-leverage edit." },
          { title: "Export", body: "One-click CSV with all queries across all URLs — drop into a brief, a sheet, or hand to a writer." },
        ]}
        faqs={[
          { title: "Why are some URLs empty?", body: "GSC returns no rows for that URL in the window. Usually means the URL has zero impressions, isn't indexed, or doesn't match the property's URL form exactly (trailing slash, http vs https, www)." },
          { title: "What does 'estimated incremental clicks' mean?", body: "impressions × (target-CTR − current-CTR), where target CTR is the industry-average CTR if the query moved into a better band. It's a relative ranker, not a forecast." },
        ]}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            URL list
            <InfoTip>One URL per line. Up to 50 per run. Duplicates and non-http URLs are dropped.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`https://wellows.com/blog/ai-overviews-optimization/\nhttps://wellows.com/blog/what-is-content-cannibalization/\n...`}
            rows={10}
            className="font-mono text-xs"
          />
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Window (days)</label>
              <Input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 28)))}
                className="w-24"
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {urlList.length} valid URL{urlList.length === 1 ? "" : "s"} detected
            </div>
            <div className="ml-auto flex gap-2">
              {data && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyTsv("all", toTsv(data.results))}
                    title="Copy all rows as tab-separated values — paste straight into Google Sheets / Excel"
                  >
                    {copiedKey === "all" ? <Check className="h-4 w-4 mr-2 text-green-600" /> : <Copy className="h-4 w-4 mr-2" />}
                    {copiedKey === "all" ? "Copied!" : "Copy for Google Sheets"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadCsv}>
                    <Download className="h-4 w-4 mr-2" />
                    Export CSV
                  </Button>
                </>
              )}
              <Button onClick={run} disabled={loading || urlList.length === 0}>
                {loading ? <><Spinner className="h-4 w-4 mr-2" />Fetching…</> : <><Play className="h-4 w-4 mr-2" />Extract & Prioritize</>}
              </Button>
            </div>
          </div>
          {error && (
            <div className="text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div>
              Window: <span className="font-mono">{data.range.startDate} → {data.range.endDate}</span> ({data.range.days} days)
            </div>
            <div className="flex gap-3">
              <button onClick={expandAll} className="hover:text-foreground">Expand all</button>
              <button onClick={collapseAll} className="hover:text-foreground">Collapse all</button>
            </div>
          </div>
          {data.results.map((r) => {
            const isOpen = expanded.has(r.url);
            return (
              <Card key={r.url} className={cn(!r.ok && "border-red-500/40")}>
                <button
                  type="button"
                  onClick={() => toggle(r.url)}
                  className="w-full text-left p-4 flex items-start gap-3 hover:bg-muted/40 transition-colors"
                >
                  {isOpen ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-sm text-primary hover:underline truncate inline-flex items-center gap-1"
                      >
                        <span className="truncate">{r.url}</span>
                        <ExternalLink className="h-3 w-3 opacity-70 shrink-0" />
                      </a>
                      {!r.ok && <Badge variant="destructive">Error</Badge>}
                    </div>
                    {r.ok && r.totals && (
                      <div className="text-xs text-muted-foreground mt-1 font-mono">
                        {r.queries.length} queries · {r.totals.clicks.toLocaleString()} clicks · {r.totals.impressions.toLocaleString()} impressions · avg pos {r.totals.position.toFixed(1)} · CTR {(r.totals.ctr * 100).toFixed(2)}%
                      </div>
                    )}
                    {!r.ok && (
                      <div className="text-xs text-red-600 mt-1">{r.error}</div>
                    )}
                  </div>
                </button>
                {isOpen && r.ok && (
                  <CardContent className="pt-0">
                    {r.queries.length > 0 && (
                      <div className="flex justify-end mb-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copyTsv(r.url, toTsv(data.results, r.url));
                          }}
                          className="h-7 text-xs"
                        >
                          {copiedKey === r.url ? <Check className="h-3.5 w-3.5 mr-1.5 text-green-600" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
                          {copiedKey === r.url ? "Copied!" : "Copy this URL's rows"}
                        </Button>
                      </div>
                    )}
                    {r.queries.length === 0 ? (
                      <div className="text-sm text-muted-foreground italic py-4">
                        No queries returned by GSC for this URL in the window. Check the URL form (trailing slash, http/https, www) matches your property exactly.
                      </div>
                    ) : (
                      <div className="overflow-x-auto -mx-4 px-4">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b text-muted-foreground text-left">
                              <th className="py-2 pr-3 font-medium">#</th>
                              <th className="py-2 pr-3 font-medium">
                                <span className="inline-flex items-center gap-1">Query <InfoTip>{COLUMN_TIPS["query"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium">
                                <span className="inline-flex items-center gap-1">Tier <InfoTip>{COLUMN_TIPS["tier"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">Priority <InfoTip>{COLUMN_TIPS["priority"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">Est. +clicks <InfoTip>{COLUMN_TIPS["est"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">Clicks <InfoTip>{COLUMN_TIPS["clicks"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">Impr. <InfoTip>{COLUMN_TIPS["impr"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">CTR <InfoTip>{COLUMN_TIPS["ctr"]!}</InfoTip></span>
                              </th>
                              <th className="py-2 pr-3 font-medium text-right">
                                <span className="inline-flex items-center gap-1 justify-end">Pos. <InfoTip>{COLUMN_TIPS["pos"]!}</InfoTip></span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.queries.map((q, i) => (
                              <tr key={`${q.query}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                                <td className="py-2 pr-3 font-mono text-muted-foreground">{i + 1}</td>
                                <td className="py-2 pr-3 font-medium" title={q.reason}>{q.query}</td>
                                <td className="py-2 pr-3">
                                  <Tooltip delayDuration={150}>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="outline"
                                        className={cn("text-[10px] font-normal cursor-help", TIER_COLOR[q.tier])}
                                      >
                                        {TIER_LABEL[q.tier]}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs text-xs leading-relaxed">
                                      {TIER_TOOLTIP[q.tier]}
                                    </TooltipContent>
                                  </Tooltip>
                                </td>
                                <td className="py-2 pr-3 text-right font-mono font-semibold">{q.priority.toFixed(1)}</td>
                                <td className="py-2 pr-3 text-right font-mono">{q.estIncrementalClicks.toFixed(1)}</td>
                                <td className="py-2 pr-3 text-right font-mono">{q.clicks.toLocaleString()}</td>
                                <td className="py-2 pr-3 text-right font-mono">{q.impressions.toLocaleString()}</td>
                                <td className="py-2 pr-3 text-right font-mono">{(q.ctr * 100).toFixed(2)}%</td>
                                <td className="py-2 pr-3 text-right font-mono">{q.position.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function GscBulkQueries() {
  return (
    <GscLayout>
      <BulkQueriesBody />
    </GscLayout>
  );
}
