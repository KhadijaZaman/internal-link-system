import { Fragment, useEffect, useState } from "react";
import {
  useListSuggestions,
  useActSuggestion,
  useGetAuditReport,
  useGetLinkingSettings,
  useUpdateLinkingSettings,
  useRunJob,
  useListWpExcludeList,
  useAddWpExclude,
  useDeleteWpExclude,
  useGetPruningSuggestions,
  getGetPruningSuggestionsQueryKey,
  getListSuggestionsQueryKey,
  getGetAuditReportQueryKey,
  getGetLinkingSettingsQueryKey,
  getListWpExcludeListQueryKey,
  ListSuggestionsStatus,
  SuggestionActionInputAction,
  type LinkSuggestion,
} from "@workspace/api-client-react";
import { HowThisWorks } from "@/components/how-this-works";

const TIER_NAMES: Record<string, string> = {
  T1: "T1 — Home / top-of-funnel landing pages",
  T2: "T2 — Pillar / hub pages (primary topic clusters)",
  T3: "T3 — Cluster / supporting pages (sub-topics)",
  T4: "T4 — Leaf / long-tail content (deepest articles)",
};

function tierPairExplanation(pair: string | null | undefined): string {
  if (!pair) return "Tier pair unknown";
  const m = /^(T\d)\s*(?:→|->|to)\s*(T\d)$/i.exec(pair);
  if (!m) return `${pair} — donor/receiver section labels`;
  const from = m[1]!.toUpperCase();
  const to = m[2]!.toUpperCase();
  return `${TIER_NAMES[from] ?? from} → ${TIER_NAMES[to] ?? to}. Tiers describe a page's role in the site hierarchy: T1 = home, T2 = pillar/hub, T3 = cluster/supporting, T4 = leaf/long-tail. A T4→T3 link, for example, sends authority from a deep article up to its parent cluster page.`;
}

function engineVersionExplanation(v: string | null | undefined): string {
  if (v === "semantic-v1")
    return "semantic-v1 — current engine. Uses OpenAI embeddings + GSC weighting + tier/anchor fit + freshness to score every page pair. Suggested anchors use the receiver's H1.";
  if (v === "legacy-v0")
    return "legacy-v0 — original keyword-matching engine, kept for backward-compatible suggestions. Lower precision than semantic-v1.";
  if (v === "structural-v1")
    return "structural-v1 — same scoring + consistency gate as semantic-v1, but triggered on-demand from Structural Fixes to repair a specific orphan or dead-end page.";
  return v ? `${v} — internal engine version label` : "Engine version unknown";
}
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Check, X, Trash2, Plus, RefreshCw, ExternalLink, AlertTriangle, Scissors, Send, ChevronRight, ChevronDown } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { cleanCell, rowsToTsv } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import type {
  PruningSuggestion,
  PruningQueryDetail,
} from "@workspace/api-client-react";

const STATUS_OPTIONS: { value: ListSuggestionsStatus; label: string }[] = [
  { value: ListSuggestionsStatus.pending_review, label: "Pending Review" },
  { value: ListSuggestionsStatus.approved, label: "Approved" },
  { value: ListSuggestionsStatus.rejected, label: "Rejected" },
  { value: ListSuggestionsStatus.inserted, label: "Inserted" },
  { value: ListSuggestionsStatus.all, label: "All" },
];

function copy(text: string, toastFn: (o: { title: string }) => void): void {
  void navigator.clipboard.writeText(text).then(() => toastFn({ title: "Copied to clipboard" }));
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildHtmlAnchor(s: LinkSuggestion, anchor: string): string {
  // The result is copied to the clipboard and likely pasted into a CMS HTML
  // editor. Escape so a URL or anchor containing `"`, `<`, or `>` can't
  // break the markup or sneak extra attributes/elements into the operator's
  // post when they paste.
  return `<a href="${escapeHtmlAttr(s.receiverUrl)}">${escapeHtmlText(anchor)}</a>`;
}

function buildMarkdownAnchor(s: LinkSuggestion, anchor: string): string {
  return `[${anchor}](${s.receiverUrl})`;
}

function ScoreChip({ label, value }: { label: string; value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  return (
    <Badge variant="outline" className="text-[10px] font-mono">
      {label} {pct}
    </Badge>
  );
}

function InboxTab() {
  const [status, setStatus] = useState<ListSuggestionsStatus>(ListSuggestionsStatus.pending_review);
  const [engineFilter, setEngineFilter] = useState<"all" | "semantic-v1" | "legacy-v0">("all");
  const { data, isLoading } = useListSuggestions({ status });
  const act = useActSuggestion();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleAction = (id: number, action: SuggestionActionInputAction) => {
    act.mutate(
      { id, data: { action } },
      {
        onSuccess: () => {
          toast({ title: `Suggestion ${action}` });
          qc.invalidateQueries({ queryKey: getListSuggestionsQueryKey({ status }) });
        },
        onError: () => toast({ title: "Action failed" }),
      },
    );
  };

  const rows = (data ?? []).filter((r) =>
    engineFilter === "all" ? true : (r.engineVersion ?? "legacy-v0") === engineFilter,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as ListSuggestionsStatus)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Select value={engineFilter} onValueChange={(v) => setEngineFilter(v as typeof engineFilter)}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" title="Show suggestions from every engine version in one combined list. Useful when you're triaging the whole inbox and don't care which engine produced the suggestion.">
                  All engines
                </SelectItem>
                <SelectItem value="semantic-v1" title="Current engine. Scores every page-pair using OpenAI embeddings + GSC clicks/impressions weighting + tier/anchor fit + freshness. Anchor text is built from the receiver page's H1. Higher precision; this is the recommended filter for normal review.">
                  Semantic v1
                </SelectItem>
                <SelectItem value="legacy-v0" title="Original keyword-matching engine, kept only so older suggestions in the queue stay reviewable. No embeddings, no GSC weighting — lower precision. Suggestions tagged 'legacy-v0' (or with no engine label) come from here.">
                  Legacy
                </SelectItem>
              </SelectContent>
            </Select>
            <InfoTip>
              <strong>Engine filter.</strong> The semantic linking engine has two generations of suggestions in the database:
              <br /><br />
              <strong>Semantic v1</strong> — current engine. OpenAI embeddings score how related two pages are, GSC clicks/impressions weight the donor side toward high-traffic pages, and tier/anchor-fit + freshness adjust the final rank. Anchors come from the receiver's H1.
              <br /><br />
              <strong>Legacy (v0)</strong> — original keyword-matching engine. No embeddings, no GSC weighting. Kept around so old suggestions you haven't actioned yet stay visible. Lower precision — usually safe to ignore unless you're cleaning up backlog.
              <br /><br />
              <strong>All engines</strong> — both, in one list.
            </InfoTip>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {rows.length} suggestion{rows.length === 1 ? "" : "s"}
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
          No suggestions in this view.
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source → Target</TableHead>
                <TableHead>Anchor + variants</TableHead>
                <TableHead>Placement hint</TableHead>
                <TableHead>Scores</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const variants = (s.anchorVariants ?? []).filter((v) => v && v !== s.anchorText);
                const primary = s.anchorText ?? "";
                return (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-[260px] align-top">
                      <div className="flex items-center gap-1 text-xs">
                        <Badge
                          variant="secondary"
                          className="font-mono"
                          title={tierPairExplanation(s.tierPair ?? s.sectionLinkType)}
                        >
                          {s.tierPair ?? s.sectionLinkType}
                        </Badge>
                        <Badge
                          variant={s.engineVersion === "semantic-v1" ? "default" : "outline"}
                          className="text-[10px]"
                          title={engineVersionExplanation(s.engineVersion)}
                        >
                          {s.engineVersion}
                        </Badge>
                      </div>
                      <a
                        href={s.donorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-primary hover:underline mt-1 truncate block"
                        title={`Open donor: ${s.donorUrl}`}
                      >
                        {s.donorUrl}
                      </a>
                      <a
                        href={s.receiverUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium hover:text-primary hover:underline mt-0.5 truncate block"
                        title={`Open receiver: ${s.receiverUrl}`}
                      >
                        → {s.receiverUrl}
                      </a>
                    </TableCell>
                    <TableCell className="max-w-[260px] align-top">
                      <div className="font-medium text-sm">{primary}</div>
                      {variants.length > 0 && (
                        <div className="text-[11px] text-muted-foreground mt-1">
                          alt: {variants.join(" · ")}
                        </div>
                      )}
                      <div className="flex gap-1 mt-2 flex-wrap">
                        <InfoTip>Copy this suggestion as an HTML anchor tag, ready to paste into your CMS source view.</InfoTip>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2"
                          onClick={() => copy(buildHtmlAnchor(s, primary), toast)}
                        >
                          <Copy className="h-3 w-3 mr-1" /> HTML
                        </Button>
                        <InfoTip>Copy this suggestion in Markdown link format — useful for posts authored in Markdown.</InfoTip>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2"
                          onClick={() => copy(buildMarkdownAnchor(s, primary), toast)}
                        >
                          <Copy className="h-3 w-3 mr-1" /> MD
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[320px] align-top">
                      {s.placementHint || s.insertionSentence ? (
                        <div className="text-xs bg-muted/40 p-2 rounded border font-mono leading-snug">
                          {(s.placementHint ?? s.insertionSentence ?? "").slice(0, 280)}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">no hint</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap gap-1">
                        <ScoreChip label="sim" value={s.similarityScore} />
                        <ScoreChip label="auth" value={s.authorityScore} />
                        <ScoreChip label="fit" value={s.anchorFitScore} />
                        <ScoreChip label="fresh" value={s.freshnessScore} />
                      </div>
                      <div className="text-xs font-mono mt-1 text-muted-foreground">
                        total {(s.priorityScore ?? 0).toFixed(3)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right align-top">
                      {s.status === "pending_review" ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-end gap-1">
                            <InfoTip>Accept this link suggestion. It moves to "Approved" so you can mark it inserted after pasting it into the page.</InfoTip>
                            <Button size="sm" onClick={() => handleAction(s.id, SuggestionActionInputAction.approve)}>
                              <Check className="h-3 w-3 mr-1" /> Approve
                            </Button>
                          </div>
                          <div className="flex items-center justify-end gap-1">
                            <InfoTip>Discard this link suggestion. It won't be proposed again in future runs.</InfoTip>
                            <Button size="sm" variant="outline" onClick={() => handleAction(s.id, SuggestionActionInputAction.reject)}>
                              <X className="h-3 w-3 mr-1" /> Reject
                            </Button>
                          </div>
                        </div>
                      ) : s.status === "approved" ? (
                        <div className="flex items-center justify-end gap-1">
                          <InfoTip>Mark this approved suggestion as live on the page. Use after pasting the HTML/Markdown into your CMS.</InfoTip>
                          <Button size="sm" onClick={() => handleAction(s.id, SuggestionActionInputAction.inserted)}>
                            Mark inserted
                          </Button>
                        </div>
                      ) : (
                        <Badge variant="outline">{s.status}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

interface StatusMeaning {
  /** Short label shown in the tooltip header. */
  name: string;
  /** What this status code means in plain language. */
  meaning: string;
  /** What the operator should do about it. */
  action: string;
  /** Badge color severity. */
  severity: "info" | "warn" | "error";
}

const STATUS_MEANINGS: Record<number, StatusMeaning> = {
  301: {
    name: "Permanent redirect",
    meaning:
      "The page hasn't been deleted — it's been moved permanently to a new URL. The link still works for users (their browser will follow the redirect) but every internal link wastes a round trip and leaks a small amount of PageRank.",
    action:
      "Update your internal links to point directly at the final destination URL so Google doesn't waste crawl budget hopping through redirects.",
    severity: "warn",
  },
  302: {
    name: "Temporary redirect",
    meaning:
      "The server says this URL has temporarily moved elsewhere. Google treats 302s differently than 301s — they don't pass PageRank as cleanly and signal to Google that the move is not permanent.",
    action:
      "If the move is actually permanent, change it to a 301 on the server. If it's truly temporary, leave it but update the internal link to the canonical URL once the redirect is removed.",
    severity: "warn",
  },
  307: {
    name: "Temporary redirect (HTTP/1.1)",
    meaning:
      "Same as 302 but stricter — the request method must be preserved. Treated by Google like a 302 for SEO.",
    action:
      "If the destination is permanent, switch to a 301. Otherwise update the internal link to the canonical URL.",
    severity: "warn",
  },
  308: {
    name: "Permanent redirect (HTTP/1.1)",
    meaning:
      "Like a 301 but preserves the request method (GET/POST). Google treats 308 and 301 equivalently for SEO.",
    action:
      "Update your internal links to point at the final destination URL.",
    severity: "warn",
  },
  400: {
    name: "Bad Request",
    meaning:
      "The server refused the request as malformed. Often caused by malformed URL parameters in the link itself.",
    action:
      "Open the URL in a browser to confirm. Fix the link source if the URL is mistyped; remove the link if the page truly doesn't accept this request.",
    severity: "error",
  },
  401: {
    name: "Unauthorized",
    meaning:
      "The page exists but requires login. Search engines see this as inaccessible.",
    action:
      "Don't link from public pages to gated content. Either remove the internal link or move the destination to a public URL.",
    severity: "error",
  },
  403: {
    name: "Forbidden",
    meaning:
      "Server is actively blocking access (often a CDN/WAF rule blocking bots, or a deleted page with locked-down ACL).",
    action:
      "Check your firewall / bot-protection rules — if it's blocking the audit crawler it's probably also blocking Googlebot. Otherwise remove or replace the link.",
    severity: "error",
  },
  404: {
    name: "Not Found",
    meaning:
      "The page no longer exists at this URL. Every internal link pointing here is a dead link for both users and Google.",
    action:
      "Either restore the page, 301-redirect the URL to the best replacement, or update each linking page to point somewhere else.",
    severity: "error",
  },
  410: {
    name: "Gone",
    meaning:
      "The page has been intentionally and permanently deleted. Google de-indexes 410s faster than 404s.",
    action:
      "Remove every internal link pointing at this URL — the page is not coming back.",
    severity: "error",
  },
  429: {
    name: "Too Many Requests",
    meaning:
      "The server is rate-limiting the audit crawler. This is usually not a real broken link — the audit just got throttled.",
    action:
      "Re-run the audit later. If the host's rate limit blocks Googlebot too, whitelist Googlebot's IPs at your CDN.",
    severity: "warn",
  },
  500: {
    name: "Internal Server Error",
    meaning:
      "The destination page crashed when fetched. Affects both users and Google.",
    action:
      "Open the URL in a browser to reproduce, then fix the server error (usually a backend or plugin issue). Don't leave links pointing at a 500.",
    severity: "error",
  },
  502: {
    name: "Bad Gateway",
    meaning:
      "An upstream server / proxy failed. Usually transient infrastructure issues.",
    action:
      "Re-run the audit. If it persists, escalate to hosting / DevOps — the origin is down.",
    severity: "error",
  },
  503: {
    name: "Service Unavailable",
    meaning:
      "The server is temporarily overloaded or in maintenance mode. Often returned by CDNs during traffic spikes.",
    action:
      "Re-run the audit later. If consistent, your origin can't keep up — add caching/CDN capacity.",
    severity: "error",
  },
  504: {
    name: "Gateway Timeout",
    meaning:
      "The origin took too long to respond. Same effect as a 500 from Google's perspective.",
    action:
      "Investigate slow database queries / backend hangs on that URL. Re-run the audit after fixing.",
    severity: "error",
  },
};

function describeStatus(status: unknown): StatusMeaning {
  const n = typeof status === "number" ? status : Number(status);
  if (Number.isFinite(n) && STATUS_MEANINGS[n]) return STATUS_MEANINGS[n]!;
  if (Number.isFinite(n) && n >= 300 && n < 400)
    return {
      name: "Redirect",
      meaning: "The destination URL responds with a 3xx, meaning it forwards to another URL.",
      action: "Update your internal link to point at the final destination so Googlebot doesn't waste crawl budget on redirects.",
      severity: "warn",
    };
  if (Number.isFinite(n) && n >= 400 && n < 500)
    return {
      name: "Client error",
      meaning: "The destination URL responds with a 4xx, meaning the page is unreachable or refused.",
      action: "Remove the internal link or update it to a working URL.",
      severity: "error",
    };
  if (Number.isFinite(n) && n >= 500)
    return {
      name: "Server error",
      meaning: "The destination URL's server crashed or is unavailable.",
      action: "Investigate the origin server. If transient, re-run the audit. Otherwise fix or remove the link.",
      severity: "error",
    };
  return {
    name: "Fetch error",
    meaning: "The audit crawler couldn't even open a connection to this URL (DNS failure, TLS error, timeout, or unsafe URL).",
    action: "Open the URL in a browser to reproduce. If it loads for you but not for the crawler, check your CDN/firewall rules.",
    severity: "error",
  };
}

const SEVERITY_BADGE: Record<StatusMeaning["severity"], string> = {
  info: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  error: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

function BrokenStatusBadge({ status, error }: { status: unknown; error?: string }) {
  const meaning = describeStatus(status);
  const label = status != null ? String(status) : "ERR";
  return (
    <div className="inline-flex items-center gap-2">
      <Badge variant="outline" className={cn("font-mono", SEVERITY_BADGE[meaning.severity])}>
        {label}
      </Badge>
      <InfoTip>
        <div className="space-y-2 max-w-xs">
          <div>
            <div className="font-semibold">{label} · {meaning.name}</div>
            <div className="text-xs opacity-80 mt-0.5">{meaning.meaning}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider opacity-80">What to do</div>
            <div className="text-xs mt-0.5">{meaning.action}</div>
          </div>
        </div>
      </InfoTip>
      {error ? (
        <span className="text-[11px] text-muted-foreground truncate max-w-[260px]" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function AuditTab({ type, label }: { type: "orphans" | "over_linked"; label: string }) {
  const { data, isLoading } = useGetAuditReport(type);
  const qc = useQueryClient();
  const { toast } = useToast();
  const runJob = useRunJob();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggleRow = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const jobName = type === "orphans" ? "audit_orphans" : "audit_over_linked";

  const runNow = () => {
    runJob.mutate(
      { jobName },
      {
        onSuccess: () => {
          toast({ title: `${label} run started — refresh in ~30s` });
          setTimeout(() => qc.invalidateQueries({ queryKey: getGetAuditReportQueryKey(type) }), 30000);
        },
        onError: () => toast({ title: "Failed to start audit" }),
      },
    );
  };

  const items = (data?.items ?? []) as Array<Record<string, unknown>>;
  const copyAll = () => {
    const lines = items.map((item) => {
      if (type === "orphans") return String(item["url"]);
      if (item["kind"] === "anchor") return `[anchor] ${item["anchorText"]} (${item["count"]} uses)`;
      return `[target] ${item["url"]} (${item["count"]} inbound)`;
    });
    copy(lines.join("\n"), toast);
  };

  return (
    <div className="space-y-4">
      {type === "over_linked" && (
        <Card className="border-amber-200/60 bg-amber-50/40 dark:bg-amber-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              How a URL gets flagged as over-linked
              <InfoTip>
                Two fixed thresholds flag the worst offenders: how many in-article links point at a page, and how
                often a single anchor text repeats. Only body-text links that carry real anchor text count —
                navigation, sidebar, header, and footer links are ignored because they repeat sitewide and aren't
                an editorial linking choice.
              </InfoTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>The audit flags two things:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Target URLs</strong> receiving more than <span className="font-mono">50</span> in-article
                inbound links (body text, with anchor text) — they're soaking up more equity than any single page
                needs. <strong>Click a target row</strong> to see every page that links to it.
              </li>
              <li>
                <strong>Anchor texts</strong> repeated more than <span className="font-mono">10</span> times across
                the site — over-optimised anchors look spammy and waste anchor diversity.
              </li>
            </ul>
            <p>
              <strong>Editorial framework (for context, not used by the audit yet):</strong> a healthy page carries
              about <strong>2–4 internal links per 1,000 words</strong> (Koray Tuğberk Güğür's SOP). Each page's
              word-count corridor shows up as <span className="font-mono">Quota</span> on{" "}
              <strong>WP Classifications</strong>. Cross-reference a flagged URL against its quota and word count to
              judge whether body inbound + outbound have drifted past what the page should carry.
            </p>
            <p className="text-xs">
              Full per-page corridor flagging (inbound + outbound vs word count) is on the roadmap — today this list
              is the fixed-threshold version.
            </p>
          </CardContent>
        </Card>
      )}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-muted-foreground">
            Last run: {data?.runAt ? new Date(data.runAt).toLocaleString() : "never"}
            {data?.itemCount !== undefined && ` · ${data.itemCount} items`}
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <InfoTip>Copy every row in this audit to the clipboard as plain text — handy for sharing the list or pasting into a spreadsheet.</InfoTip>
          <Button variant="outline" onClick={copyAll} disabled={items.length === 0}>
            <Copy className="h-4 w-4 mr-1" /> Copy all
          </Button>
          <InfoTip>Re-run this audit job in the background. Results refresh automatically in about 30 seconds.</InfoTip>
          <Button onClick={runNow} disabled={runJob.isPending}>
            <RefreshCw className="h-4 w-4 mr-1" /> Run now
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
          No items in the latest report. {data?.runAt ? "" : "Run the audit to generate one."}
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {type === "orphans" && (<><TableHead>URL</TableHead><TableHead>Title</TableHead></>)}
                {type === "over_linked" && (<><TableHead>Kind</TableHead><TableHead>Target / Anchor</TableHead><TableHead>
                  <span className="inline-flex items-center gap-1">
                    Count
                    <InfoTip>
                      For targets, this is the number of <strong>in-article (body-text) inbound links that carry
                      anchor text</strong> — the figure compared against the threshold. Navigation, sidebar, header,
                      footer, and auto-generated / empty-anchor links are not counted. Click a target row to list
                      the pages that link to it.
                    </InfoTip>
                  </span>
                </TableHead></>)}
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, i) => {
                const linkingPages =
                  (item["linkingPages"] as
                    | Array<{ sourceUrl: string; anchorText: string; title: string | null }>
                    | undefined) ?? [];
                const canExpand =
                  type === "over_linked" && item["kind"] === "target" && linkingPages.length > 0;
                const isOpen = canExpand && expanded.has(i);
                return (
                  <Fragment key={i}>
                    <TableRow
                      className={cn(canExpand && "cursor-pointer")}
                      onClick={canExpand ? () => toggleRow(i) : undefined}
                    >
                      {type === "orphans" && (
                        <>
                          <TableCell className="font-mono text-xs">{String(item["url"])}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {(item["title"] as string) ?? "—"}
                          </TableCell>
                        </>
                      )}
                      {type === "over_linked" && (
                        <>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {canExpand ? (
                                isOpen ? (
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                )
                              ) : (
                                <span className="w-3.5 shrink-0" />
                              )}
                              <Badge variant="outline">{String(item["kind"])}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {String(item["anchorText"] ?? item["url"])}
                          </TableCell>
                          <TableCell className="font-mono">{String(item["count"])}</TableCell>
                        </>
                      )}
                      <TableCell className="text-right">
                        {item["url"] ? (
                          <a
                            href={String(item["url"])}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="bg-muted/30 p-0">
                          <div className="px-4 py-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-medium text-muted-foreground">
                                {linkingPages.length} page{linkingPages.length === 1 ? "" : "s"} link here in body
                                text
                              </div>
                              <CopyButton
                                variant="outline"
                                size="sm"
                                label="Copy linking pages"
                                getText={() =>
                                  rowsToTsv(
                                    ["Linking page", "Anchor text", "Title"],
                                    linkingPages.map((p) => [p.sourceUrl, p.anchorText, p.title ?? ""]),
                                  )
                                }
                              />
                            </div>
                            <ul className="divide-y rounded-md border bg-background">
                              {linkingPages.map((p, j) => (
                                <li
                                  key={j}
                                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                                >
                                  <div className="min-w-0 flex-1">
                                    <a
                                      href={p.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="block truncate font-mono hover:underline"
                                      title={p.sourceUrl}
                                    >
                                      {p.sourceUrl}
                                    </a>
                                    {p.title ? (
                                      <div className="truncate text-muted-foreground" title={p.title}>
                                        {p.title}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="shrink-0 text-right text-muted-foreground">
                                    anchor:{" "}
                                    <span className="font-medium text-foreground">“{p.anchorText}”</span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

type BrokenAction = "repoint" | "dead";

interface BrokenLinkItem {
  url: string;
  status: number | null;
  error?: string;
  inboundCount: number;
  redirectTo?: string;
  linkingPages?: { sourceUrl: string; anchorText: string; title: string | null }[];
}

/** What the operator actually has to do: repoint a working redirect, or fix a dead target. */
function classifyBrokenAction(it: BrokenLinkItem): BrokenAction {
  const n = it.status;
  if (typeof n === "number" && n >= 300 && n < 400 && it.redirectTo) return "repoint";
  return "dead";
}

/**
 * Heuristic for "this URL is almost certainly a typo in the linking page" — a
 * doubled domain (e.g. wellows.com/wellows.com/…) or a repeated path segment.
 * These aren't really redirects or dead pages; the fix is a wrong href on the
 * source page.
 */
function looksMalformedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return true;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host && path.includes(host)) return true;
  const segs = u.pathname.split("/").filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] && segs[i] === segs[i - 1]) return true;
  }
  return false;
}

function coerceBrokenItem(raw: Record<string, unknown>): BrokenLinkItem {
  const rawPages = raw["linkingPages"];
  const linkingPages = Array.isArray(rawPages)
    ? rawPages.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return {
          sourceUrl: String(o["sourceUrl"] ?? ""),
          anchorText: String(o["anchorText"] ?? ""),
          title: o["title"] != null ? String(o["title"]) : null,
        };
      })
    : undefined;
  const status = raw["status"];
  return {
    url: String(raw["url"] ?? ""),
    status: typeof status === "number" ? status : null,
    error: raw["error"] != null ? String(raw["error"]) : undefined,
    inboundCount: Number(raw["inboundCount"] ?? 0),
    redirectTo: raw["redirectTo"] != null ? String(raw["redirectTo"]) : undefined,
    linkingPages,
  };
}

type BrokenFilter = "all" | "repoint" | "dead" | "malformed";

const BROKEN_CARD_TONE: Record<"warn" | "error" | "neutral", string> = {
  warn: "border-amber-300/70 bg-amber-50/50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200",
  error: "border-red-300/70 bg-red-50/50 text-red-900 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200",
  neutral: "border-slate-300/70 bg-slate-50/70 text-slate-800 dark:border-slate-700/60 dark:bg-slate-900/30 dark:text-slate-200",
};

function BrokenLinksTab() {
  const { data, isLoading, isError } = useGetAuditReport("broken_links");
  const qc = useQueryClient();
  const { toast } = useToast();
  const runJob = useRunJob();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<BrokenFilter>("all");

  const toggleRow = (url: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const runNow = () => {
    runJob.mutate(
      { jobName: "audit_broken_links" },
      {
        onSuccess: () => {
          toast({ title: "Broken-link audit started — refresh in ~30s" });
          setTimeout(
            () => qc.invalidateQueries({ queryKey: getGetAuditReportQueryKey("broken_links") }),
            30000,
          );
        },
        onError: () => toast({ title: "Failed to start audit" }),
      },
    );
  };

  const rawItems = (data?.items ?? []) as Array<Record<string, unknown>>;
  const items = rawItems.map(coerceBrokenItem);
  const withMeta = items.map((it) => ({
    it,
    action: classifyBrokenAction(it),
    malformed: looksMalformedUrl(it.url),
  }));
  type Row = (typeof withMeta)[number];

  const repoint = withMeta.filter((m) => m.action === "repoint");
  const dead = withMeta.filter((m) => m.action === "dead");
  const malformed = withMeta.filter((m) => m.malformed);
  const sumInbound = (arr: Row[]) => arr.reduce((a, m) => a + (m.it.inboundCount || 0), 0);
  // Impact = the actual work to do. inboundCount counts content-placement links
  // only, so a target linked solely from chrome (nav/footer) reports 0 even when
  // there are pages to edit. Rank by whichever is larger so those aren't buried.
  const impactOf = (m: Row) => Math.max(m.it.inboundCount || 0, m.it.linkingPages?.length ?? 0);
  const byImpact = (a: Row, b: Row) => impactOf(b) - impactOf(a);

  const visible = withMeta
    .filter((m) =>
      filter === "all"
        ? true
        : filter === "repoint"
          ? m.action === "repoint"
          : filter === "dead"
            ? m.action === "dead"
            : m.malformed,
    )
    .sort(byImpact);

  const copyRepointMap = () =>
    copy(
      rowsToTsv(
        ["Current URL", "Repoint to", "Inbound links"],
        [...repoint].sort(byImpact).map((m) => [m.it.url, m.it.redirectTo ?? "", String(m.it.inboundCount)]),
      ),
      toast,
    );

  const copyAll = () => {
    const lines: string[] = [];
    if (repoint.length) {
      lines.push("== Repoint redirects (update the internal link to point at the final URL) ==");
      for (const m of [...repoint].sort(byImpact)) {
        lines.push(
          `${cleanCell(m.it.url)}\t→\t${cleanCell(m.it.redirectTo)}\t(${m.it.inboundCount} inbound)`,
        );
      }
      lines.push("");
    }
    if (dead.length) {
      lines.push("== Fix dead links (restore the page, add a 301, or update/remove the links) ==");
      for (const m of [...dead].sort(byImpact)) {
        lines.push(
          `${cleanCell(m.it.url)}\t${cleanCell(m.it.status ?? "fetch-error")}\t(${m.it.inboundCount} inbound)${m.it.error ? `\t${cleanCell(m.it.error)}` : ""}`,
        );
      }
    }
    copy(lines.join("\n"), toast);
  };

  const cards: {
    key: BrokenFilter;
    title: string;
    count: number;
    affected: number;
    tone: "warn" | "error" | "neutral";
    body: string;
  }[] = [
    {
      key: "repoint",
      title: "Repoint redirects",
      count: repoint.length,
      affected: sumInbound(repoint),
      tone: "warn",
      body: "These links still resolve, but every visit makes Googlebot take an extra hop and leaks a little PageRank. Update each internal link to point straight at the final URL.",
    },
    {
      key: "dead",
      title: "Fix dead links",
      count: dead.length,
      affected: sumInbound(dead),
      tone: "error",
      body: "These targets return 404/5xx or won't load. Restore the page, add a 301 to the best replacement, or update/remove every internal link pointing at them.",
    },
  ];
  if (malformed.length) {
    cards.push({
      key: "malformed",
      title: "Check malformed links",
      count: malformed.length,
      affected: sumInbound(malformed),
      tone: "neutral",
      body: "These URLs look like typos or doubled domains. The bad link is a wrong href in the linking page — open the affected pages and fix it at the source.",
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const active = filter === c.key;
          return (
            <div
              key={c.key}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => setFilter(active ? "all" : c.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFilter(active ? "all" : c.key);
                }
              }}
              className={cn(
                "rounded-lg border p-4 text-left transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                BROKEN_CARD_TONE[c.tone],
                active && "ring-2 ring-ring",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{c.title}</span>
                <span className="text-2xl font-bold tabular-nums">{c.count}</span>
              </div>
              <div className="mt-0.5 text-xs opacity-80">
                {c.affected} internal link{c.affected === 1 ? "" : "s"} affected
              </div>
              <p className="mt-2 text-xs opacity-90">{c.body}</p>
              {c.key === "repoint" && repoint.length > 0 && (
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 bg-background/60 text-[11px]"
                    onClick={copyRepointMap}
                  >
                    <Copy className="mr-1 h-3 w-3" /> Copy repoint map
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Last run: {data?.runAt ? new Date(data.runAt).toLocaleString() : "never"}
            {data?.itemCount !== undefined && ` · ${data.itemCount} issue${data.itemCount === 1 ? "" : "s"}`}
          </span>
          {filter !== "all" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("all")}
            >
              <X className="mr-1 h-3 w-3" /> Clear filter
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <InfoTip>
            The audit sends a HEAD request to every internal link target and lists anything that
            isn't a clean 200 OK — including 3xx redirects, which still work for users but waste
            crawl budget and leak PageRank, so they belong on the clean-up list.
          </InfoTip>
          <Button variant="outline" onClick={copyAll} disabled={items.length === 0}>
            <Copy className="mr-1 h-4 w-4" /> Copy action list
          </Button>
          <Button onClick={runNow} disabled={runJob.isPending}>
            <RefreshCw className="mr-1 h-4 w-4" /> Run now
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-dashed border-red-300/60 p-12 text-center text-sm text-red-600 dark:text-red-400">
          Couldn't load the broken-link report. Try again, or run the audit.
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          {data?.runAt
            ? "Every internal link resolves to 200 OK in the latest crawl — nothing to fix."
            : "Run the audit to check every internal link target."}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          No links match this filter.{" "}
          <button className="underline" onClick={() => setFilter("all")}>
            Show all
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Link target</TableHead>
                <TableHead>What to do</TableHead>
                <TableHead className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    Inbound
                    <InfoTip>
                      How many internal pages link to this URL — the higher the number, the more
                      crawl budget and equity the issue touches. Rows are sorted by impact, so start
                      at the top.
                    </InfoTip>
                  </span>
                </TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ it, action, malformed: isMalformed }) => {
                const pages = it.linkingPages ?? [];
                const canExpand = pages.length > 0;
                const isOpen = canExpand && expanded.has(it.url);
                const meaning = describeStatus(it.status);
                return (
                  <Fragment key={it.url}>
                    <TableRow
                      className={cn(canExpand && "cursor-pointer")}
                      onClick={canExpand ? () => toggleRow(it.url) : undefined}
                    >
                      <TableCell className="max-w-[360px] align-top">
                        <div className="flex items-start gap-1.5">
                          {canExpand ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleRow(it.url);
                              }}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Hide pages to edit" : "Show pages to edit"}
                              className="mt-0.5 shrink-0 rounded text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                          ) : (
                            <span className="w-3.5 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="break-all font-mono text-xs">{it.url}</div>
                            {isMalformed && (
                              <Badge
                                variant="outline"
                                className={cn("mt-1 text-[10px]", SEVERITY_BADGE.warn)}
                              >
                                likely typo / malformed URL
                              </Badge>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[400px] align-top">
                        <BrokenStatusBadge status={it.status} error={it.error} />
                        <div className="mt-1 text-[11px] text-muted-foreground">{meaning.action}</div>
                        {it.redirectTo && (
                          <div
                            className="mt-1 flex items-center gap-1 text-[11px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="shrink-0 opacity-70">→ repoint to</span>
                            <a
                              href={it.redirectTo}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate font-mono text-amber-700 hover:underline dark:text-amber-400"
                              title={it.redirectTo}
                            >
                              {it.redirectTo}
                            </a>
                            <CopyButton
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1"
                              label=""
                              getText={() => it.redirectTo ?? ""}
                            />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="font-mono">{it.inboundCount}</div>
                        {canExpand && (
                          <div className="text-[10px] text-muted-foreground">
                            {pages.length} page{pages.length === 1 ? "" : "s"} to edit
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="bg-muted/30 p-0">
                          <div className="space-y-2 px-4 py-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-medium text-muted-foreground">
                                Edit the link on {pages.length} page{pages.length === 1 ? "" : "s"}
                                {action === "repoint"
                                  ? " — point it at the final URL above"
                                  : " — repoint it to a live page or remove it"}
                              </div>
                              <CopyButton
                                variant="outline"
                                size="sm"
                                label="Copy pages"
                                getText={() =>
                                  rowsToTsv(
                                    ["Linking page", "Anchor text", "Title"],
                                    pages.map((p) => [p.sourceUrl, p.anchorText, p.title ?? ""]),
                                  )
                                }
                              />
                            </div>
                            <ul className="divide-y rounded-md border bg-background">
                              {pages.map((p, j) => (
                                <li
                                  key={j}
                                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                                >
                                  <div className="min-w-0 flex-1">
                                    <a
                                      href={p.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="block truncate font-mono hover:underline"
                                      title={p.sourceUrl}
                                    >
                                      {p.sourceUrl}
                                    </a>
                                    {p.title ? (
                                      <div className="truncate text-muted-foreground" title={p.title}>
                                        {p.title}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="shrink-0 text-right text-muted-foreground">
                                    anchor:{" "}
                                    <span className="font-medium text-foreground">
                                      “{p.anchorText || "—"}”
                                    </span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

const INTENT_BADGE: Record<"on" | "off" | "unknown", string> = {
  on: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  off: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
  unknown: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

const INTENT_LABEL: Record<"on" | "off" | "unknown", string> = {
  on: "On-intent",
  off: "Off-intent",
  unknown: "Not classified",
};

const INTENT_EXPLAIN: Record<"on" | "off" | "unknown", string> = {
  on:
    "This query is semantically close to what the page is actually about. Ranking #1–3 here and getting zero clicks is a real problem.",
  off:
    "This query doesn't match what the page is about (e.g. a competitor brand name or unrelated topic the page mentions in passing). It's expected to earn zero clicks and shouldn't count against the page.",
  unknown:
    "We don't have an embedding yet for the page or the query, so we can't classify intent. Will resolve on the next recompute.",
};

const VERDICT_STYLE: Record<
  "on_intent_no_clicks" | "off_intent_only" | "mixed" | "unknown",
  { label: string; badge: string; meaning: string }
> = {
  on_intent_no_clicks: {
    label: "Prune candidate",
    badge: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    meaning:
      "Every top-3 query on this page is on-intent and yet earns zero clicks. The page is ranking for what it's about and nobody's clicking — strong pruning / consolidation candidate.",
  },
  mixed: {
    label: "Review",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
    meaning:
      "Some top-3 queries are on-intent (no clicks → real problem) and some are off-intent noise. Check the on-intent queries before pruning — the off-intent ones don't matter.",
  },
  off_intent_only: {
    label: "Likely safe",
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
    meaning:
      "Every top-3 query is off-intent — the page is ranking for things it isn't really about. Not actually a pruning concern; these accidental rankings won't convert and shouldn't be held against the page.",
  },
  unknown: {
    label: "Awaiting classification",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
    meaning:
      "We haven't embedded the page or its queries yet. Recompute again once the embedding job has run.",
  },
};

function QueryBadge({ detail }: { detail: PruningQueryDetail }) {
  const intent = (detail.intent ?? "unknown") as "on" | "off" | "unknown";
  const truncated =
    detail.query.length > 50 ? detail.query.slice(0, 50) + "…" : detail.query;
  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "text-[11px] max-w-[260px] truncate cursor-help",
            INTENT_BADGE[intent],
          )}
        >
          {truncated}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 text-xs">
        <div className="space-y-2">
          <div className="font-medium break-words">{detail.query}</div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={cn("font-mono", INTENT_BADGE[intent])}>
              {INTENT_LABEL[intent]}
              {detail.similarity != null
                ? ` · sim ${(detail.similarity * 100).toFixed(0)}%`
                : ""}
            </Badge>
          </div>
          <div className="text-muted-foreground">{INTENT_EXPLAIN[intent]}</div>
          <div className="grid grid-cols-3 gap-2 pt-1 border-t">
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">
                Best pos.
              </div>
              <div className="font-mono">
                {detail.bestPosition != null
                  ? detail.bestPosition.toFixed(1)
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">
                Impr.
              </div>
              <div className="font-mono">
                {(detail.impressions ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">
                Volume
                <span className="text-muted-foreground/60"> /mo</span>
              </div>
              <div className="font-mono">
                {detail.searchVolume != null
                  ? detail.searchVolume.toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>
          {detail.searchVolume === null ? (
            <div className="text-[10px] text-muted-foreground">
              Monthly volume not yet fetched from DataForSEO — it backfills in
              batches over subsequent recomputes.
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function PruningTab() {
  const { data, isLoading, refetch, isFetching } = useGetPruningSuggestions();
  const { toast } = useToast();

  const items: PruningSuggestion[] = data?.items ?? [];

  const copyAll = () => {
    const lines = items.map(
      (i) =>
        `${i.url}\t${i.intentVerdict ?? "unknown"}\t${i.onIntentQueries ?? 0} on-intent\t${
          i.onIntentVolume ?? "?"
        } vol/mo\t${i.totalImpressions} impr\t0 clicks`,
    );
    copy(lines.join("\n"), toast);
  };

  return (
    <div className="space-y-4">
      <Card className="border-amber-200/60 bg-amber-50/40 dark:bg-amber-950/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Scissors className="h-4 w-4 text-amber-600" />
            Content pruning rule — intent-aware
            <InfoTip>
              We start with every page that hit top-3 over the analyzed window
              with zero total clicks, then classify each ranked query as
              on-intent vs off-intent using semantic similarity against the
              page's embedding. A page only stays on this list if its
              <strong> on-intent</strong> queries (the ones actually about the
              page) earn zero clicks. Off-intent accidental rankings are
              filtered out.
            </InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            A page lands here when it has reached <strong>position ≤ 3</strong>{" "}
            for at least one query in the window <strong>and</strong>{" "}
            generated <strong>0 clicks total</strong> <strong>and</strong> at
            least one of those top-3 queries is on-intent for the page.
          </p>
          <p>
            <strong className="text-emerald-700 dark:text-emerald-400">On-intent</strong> = the
            query's embedding is close (cosine similarity ≥ 0.35) to the
            page's embedding. <strong className="text-slate-700 dark:text-slate-300">Off-intent</strong> = the
            page accidentally ranks for the query (e.g. a competitor brand
            name it mentions once). Off-intent rankings don't count against
            the page.
          </p>
          <p>
            Monthly <strong>search volume</strong> on each query comes from
            DataForSEO so you can tell "0 clicks because nobody searches" from
            "0 clicks despite real demand". Volumes backfill in batches across
            recomputes.
          </p>
          <p>
            <strong>Operator queries excluded.</strong> Queries containing{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-foreground">site:</code>,{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-foreground">inurl:</code>, or{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-foreground">intitle:</code> are
            stripped before scoring — those are crawler probes and brand audits, not natural
            search demand, and they'd inflate the zero-click list with rankings nobody would ever
            click.
          </p>
          <p>
            Window:{" "}
            <span className="font-mono">
              {data?.windowStart ?? "—"} → {data?.windowEnd ?? "—"}
            </span>{" "}
            ({data?.totalDays ?? 0} day{data?.totalDays === 1 ? "" : "s"} of
            data). Accuracy grows as the Search Console snapshot history
            accumulates over 3–6 months.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Last computed:{" "}
          {data?.runAt ? new Date(data.runAt).toLocaleString() : "never"}
          {data ? ` · ${data.itemCount} candidate${data.itemCount === 1 ? "" : "s"}` : ""}
        </div>
        <div className="flex gap-2 items-center">
          <InfoTip>Copy every pruning candidate as a tab-separated list — paste straight into a spreadsheet for sign-off.</InfoTip>
          <Button variant="outline" onClick={copyAll} disabled={items.length === 0}>
            <Copy className="h-4 w-4 mr-1" /> Copy all
          </Button>
          <InfoTip>
            Recompute the pruning suggestions against the latest Search Console
            snapshots. Also backfills query embeddings and DataForSEO search
            volumes for any queries we haven't classified yet (capped per run
            to stay within quota).
          </InfoTip>
          <Button onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4 mr-1", isFetching && "animate-spin")} /> Recompute
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
          No pruning candidates found in the current window. Either every
          ranking page is converting at least one click, every zero-click page
          is only ranking for off-intent queries (filtered out by the
          intent-aware rule), or there isn't enough Search Console history
          yet.
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead className="w-[150px]">
                  <span className="inline-flex items-center gap-1">
                    Verdict
                    <InfoTip>
                      Plain-language summary based on the intent split.{" "}
                      <strong>Prune candidate</strong> = every top-3 query is
                      on-intent and earns 0 clicks. <strong>Review</strong> =
                      mix of on-intent and off-intent — check the on-intent
                      ones. <strong>Awaiting</strong> = embeddings still
                      backfilling.
                    </InfoTip>
                  </span>
                </TableHead>
                <TableHead className="w-[80px]">
                  <span className="inline-flex items-center gap-1">
                    Best pos.
                    <InfoTip>Best (lowest) position the page reached for any query in the window.</InfoTip>
                  </span>
                </TableHead>
                <TableHead className="w-[110px]">
                  <span className="inline-flex items-center gap-1">
                    On / Off
                    <InfoTip>
                      Count of top-3 queries classified as on-intent (relevant
                      to the page) vs off-intent (accidental rankings on
                      unrelated queries).
                    </InfoTip>
                  </span>
                </TableHead>
                <TableHead className="w-[110px]">
                  <span className="inline-flex items-center gap-1">
                    On-intent vol.
                    <InfoTip>
                      Sum of monthly Google search volume across the
                      on-intent top-3 queries (DataForSEO). High volume + 0
                      clicks = real demand the page is failing to capture.
                      "?" = volumes still being fetched.
                    </InfoTip>
                  </span>
                </TableHead>
                <TableHead className="w-[100px]">
                  <span className="inline-flex items-center gap-1">
                    Impr.
                    <InfoTip>Total Search Console impressions across all queries in the window.</InfoTip>
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    Top ranking queries
                    <InfoTip>
                      Up to 5 of the page's top-3 queries, on-intent first.
                      Hover any badge for similarity, position, impressions,
                      and monthly volume.
                    </InfoTip>
                  </span>
                </TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => {
                const verdict = (p.intentVerdict ?? "unknown") as keyof typeof VERDICT_STYLE;
                const v = VERDICT_STYLE[verdict];
                const onCount = p.onIntentQueries ?? 0;
                const offCount = p.offIntentQueries ?? 0;
                const details = (p.queryDetails ?? []) as PruningQueryDetail[];
                const shown = details.slice(0, 5);
                const remaining = details.length - shown.length;
                return (
                  <TableRow key={p.url}>
                    <TableCell className="align-top max-w-[300px]">
                      <div className="text-sm font-medium truncate" title={p.title ?? p.url}>
                        {p.title ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono truncate" title={p.url}>
                        {p.url}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="inline-flex items-center gap-1">
                        <Badge variant="outline" className={cn("text-[11px]", v.badge)}>
                          {v.label}
                        </Badge>
                        <InfoTip>{v.meaning}</InfoTip>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="outline" className="font-mono">
                        {p.bestPosition.toFixed(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex items-center gap-1 text-xs font-mono">
                        <span className={cn(onCount > 0 && "text-emerald-700 dark:text-emerald-400 font-semibold")}>
                          {onCount}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-muted-foreground">{offCount}</span>
                      </div>
                    </TableCell>
                    <TableCell className="align-top font-mono text-sm">
                      {p.onIntentVolume != null
                        ? p.onIntentVolume.toLocaleString()
                        : <span className="text-muted-foreground">?</span>}
                    </TableCell>
                    <TableCell className="align-top font-mono text-sm">
                      {p.totalImpressions.toLocaleString()}
                    </TableCell>
                    <TableCell className="align-top max-w-[420px]">
                      <div className="flex flex-wrap gap-1">
                        {shown.map((d, i) => (
                          <QueryBadge key={i} detail={d} />
                        ))}
                        {remaining > 0 && (
                          <Badge variant="outline" className="text-[11px]">
                            +{remaining}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right align-top">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ExcludeTab() {
  const { data, isLoading } = useListWpExcludeList();
  const qc = useQueryClient();
  const add = useAddWpExclude();
  const del = useDeleteWpExclude();
  const { toast } = useToast();
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: getListWpExcludeListQueryKey() });

  const handleAdd = () => {
    if (!pattern.trim()) return;
    add.mutate(
      { data: { pattern: pattern.trim(), note: note.trim() || null } },
      {
        onSuccess: () => { toast({ title: "Added" }); setPattern(""); setNote(""); refresh(); },
        onError: () => toast({ title: "Failed (maybe duplicate)" }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Add pattern
            <InfoTip>Add a URL pattern that the semantic linker should ignore entirely — both as a link source and as a target.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 items-center">
          <Input placeholder="/thank-you or /legal/*" value={pattern} onChange={(e) => setPattern(e.target.value)} className="font-mono" />
          <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <InfoTip>Save the exclusion. Future linking runs will skip these URLs immediately.</InfoTip>
          <Button onClick={handleAdd} disabled={add.isPending || !pattern.trim()}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="border rounded-lg border-dashed p-12 text-center text-muted-foreground">
          No patterns yet.
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-sm">{i.pattern}</TableCell>
                    <TableCell className="text-muted-foreground">{i.note ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: i.id }, { onSuccess: refresh })}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SettingsTab() {
  const { data, isLoading } = useGetLinkingSettings();
  const update = useUpdateLinkingSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState<{
    similarityThreshold: number;
    densityMinPer1000: number;
    densityMaxPer1000: number;
    hubDensityMaxPer1000: number;
    moneyDensityMaxPer1000: number;
    shortPageMaxLinks: number;
  } | null>(null);

  const view = form ?? (data
    ? {
        similarityThreshold: data.similarityThreshold,
        densityMinPer1000: data.densityMinPer1000,
        densityMaxPer1000: data.densityMaxPer1000,
        hubDensityMaxPer1000: data.hubDensityMaxPer1000,
        moneyDensityMaxPer1000: data.moneyDensityMaxPer1000,
        shortPageMaxLinks: data.shortPageMaxLinks,
      }
    : null);

  const setField = <K extends keyof NonNullable<typeof form>>(k: K, v: number) => {
    if (!view) return;
    setForm({ ...view, [k]: v });
  };

  const save = () => {
    if (!view) return;
    update.mutate(
      { data: view },
      {
        onSuccess: () => {
          toast({ title: "Settings saved" });
          setForm(null);
          qc.invalidateQueries({ queryKey: getGetLinkingSettingsQueryKey() });
        },
        onError: () => toast({ title: "Save failed" }),
      },
    );
  };

  if (isLoading || !view) return <div className="flex justify-center py-12"><Spinner /></div>;

  const num = (label: string, k: keyof NonNullable<typeof form>, step: number, hint: string) => (
    <div className="grid grid-cols-3 items-center gap-3 py-2 border-b">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <Input
        type="number"
        step={step}
        value={view[k]}
        onChange={(e) => setField(k, Number(e.target.value))}
        className="font-mono"
      />
      <div className="text-xs text-muted-foreground">current: {data?.[k]}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Semantic linking engine settings
            <InfoTip>Tunable knobs for the semantic linking engine — similarity thresholds, link density corridors, and special caps for hub/money/short pages.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {num("Similarity threshold", "similarityThreshold", 0.01, "Minimum cosine similarity for a candidate (SOP §7.2 rule 2). Default 0.65.")}
          {num("Density min per 1000 words", "densityMinPer1000", 0.1, "Lower bound of the 2–4 corridor. Donors below this get a score boost so the engine fills under-linked pages first (this is a soft preference, not a hard quota).")}
          {num("Density max per 1000 words", "densityMaxPer1000", 0.1, "Upper bound of the 2–4 corridor.")}
          {num("Hub density max", "hubDensityMaxPer1000", 0.1, "Override for glossary / hub pages.")}
          {num("Money page density max", "moneyDensityMaxPer1000", 0.1, "Override for Tier-1 money pages.")}
          {num("Short page max links", "shortPageMaxLinks", 1, "Cap for pages under 400 words.")}
          <div className="flex justify-end gap-2 pt-4 items-center">
            <InfoTip>Discard unsaved edits and revert the form to the currently saved values.</InfoTip>
            <Button variant="outline" disabled={!form} onClick={() => setForm(null)}>Reset</Button>
            <InfoTip>Persist these settings. They take effect on the next semantic linking run.</InfoTip>
            <Button onClick={save} disabled={!form || update.isPending}>Save</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const VALID_TABS = ["inbox", "orphans", "over_linked", "broken", "pruning", "exclude", "settings"] as const;
type SemanticLinksTab = (typeof VALID_TABS)[number];

function readTabFromHash(): SemanticLinksTab {
  if (typeof window === "undefined") return "inbox";
  const h = window.location.hash.replace(/^#/, "");
  return (VALID_TABS as readonly string[]).includes(h) ? (h as SemanticLinksTab) : "inbox";
}

export default function SemanticLinks() {
  const runJob = useRunJob();
  const { toast } = useToast();
  const [tab, setTabState] = useState<SemanticLinksTab>(() => readTabFromHash());
  useEffect(() => {
    const onHash = () => setTabState(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setTab = (next: string) => {
    if ((VALID_TABS as readonly string[]).includes(next)) {
      setTabState(next as SemanticLinksTab);
      if (typeof window !== "undefined" && window.location.hash !== `#${next}`) {
        history.replaceState(null, "", `#${next}`);
      }
    }
  };
  const triggerSemantic = () => {
    runJob.mutate(
      { jobName: "semantic_linking" },
      {
        onSuccess: () => toast({ title: "Semantic linking run started" }),
        onError: () => toast({ title: "Failed to start" }),
      },
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
            Semantic Links
            <InfoTip>Central hub for internal linking — review AI-generated link proposals, run audits (orphans, over-linked, broken), manage exclusions, and tune the engine.</InfoTip>
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Unified internal linking hub — proposals, audits, exclusions, and engine settings.
          </p>
          <div className="mt-3">
            <HowThisWorks
              summary="The semantic linking engine scores every page-pair on your site, suggests the best new internal links, audits orphans / over-linked / broken, and waits for your approve-or-reject decision before anything changes."
              steps={[
                { title: "Run semantic linking", body: "Click the button at the top right. The job embeds every crawled page, scores all source→target pairs, applies your settings (caps, tier rules, exclusions), and writes new proposals to the Inbox." },
                { title: "Review the Inbox", body: "Each proposal shows the donor paragraph, the suggested anchor (matched to the receiver's H1), the receiver page, and the score breakdown. Click Approve, Reject, or Copy <a>." },
                { title: "Run audits", body: "Orphans, over-linked pages, and broken links are recomputed on a schedule (or on demand). Open the Audits tab to see actionable lists and push problem pages straight to the optimizer." },
                { title: "Manage exclusions and settings", body: "Use the Exclusions and Settings tabs to keep legal/thank-you pages out of proposals and to tune caps, similarity thresholds, and how aggressively the engine links across tiers." },
              ]}
              faqs={[
                { title: "What do T1, T2, T3, T4 mean?", body: "Tiers describe where a page sits in the site hierarchy. T1 = home / top-of-funnel landing pages. T2 = pillar / hub pages (primary topic clusters). T3 = cluster / supporting pages (sub-topics). T4 = leaf / long-tail content (deepest articles). A badge like T4→T3 means the donor is a leaf article and the receiver is its parent cluster page." },
                { title: "What is semantic-v1 vs legacy-v0?", body: "semantic-v1 is the current engine — OpenAI embeddings + GSC weighting + tier/anchor fit + freshness, with anchors built from the receiver's H1. legacy-v0 is the original keyword-matching engine, kept only for backward-compatible suggestions; precision is lower." },
                { title: "Does Approve actually edit my site?", body: "No. Approve marks the proposal as accepted in this dashboard and copies the snippet to your clipboard — you still paste it into WordPress yourself." },
                { title: "Why is a proposal scored low?", body: "Scores combine semantic similarity, GSC click/impression weight, tier fit, and prominence of the donor paragraph. A low score usually means weak topical overlap or a deep, low-traffic donor." },
                { title: "How are anchors picked?", body: "We use the receiver page's H1 as the anchor by default — this keeps anchors editorially clean and aligned with the target's primary entity." },
              ]}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <InfoTip>Kick off a full semantic linking run: scores every page pair, applies your settings, and generates fresh link suggestions in the Inbox.</InfoTip>
          <Button onClick={triggerSemantic} disabled={runJob.isPending}>
            <RefreshCw className="h-4 w-4 mr-1" /> Run semantic linking
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="inbox" title="Pending link suggestions awaiting your approve/reject decision.">Inbox</TabsTrigger>
          <TabsTrigger value="orphans" title="Pages with zero internal inbound links — likely invisible to crawlers.">Orphans</TabsTrigger>
          <TabsTrigger value="over_linked" title="Anchor texts or target URLs that appear too often across the site."><AlertTriangle className="h-3 w-3 mr-1" />Over-linked</TabsTrigger>
          <TabsTrigger value="broken" title="Internal links pointing to URLs that return errors.">Broken Links</TabsTrigger>
          <TabsTrigger value="pruning" title="Pages ranking in the top 3 with zero clicks — candidates to delete or redirect."><Scissors className="h-3 w-3 mr-1" />Pruning</TabsTrigger>
          <TabsTrigger value="exclude" title="URL patterns the linker should always skip.">Exclude List</TabsTrigger>
          <TabsTrigger value="settings" title="Tune similarity thresholds and link density rules.">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="mt-4"><InboxTab /></TabsContent>
        <TabsContent value="orphans" className="mt-4"><AuditTab type="orphans" label="Orphans audit" /></TabsContent>
        <TabsContent value="over_linked" className="mt-4"><AuditTab type="over_linked" label="Over-linked audit" /></TabsContent>
        <TabsContent value="broken" className="mt-4"><BrokenLinksTab /></TabsContent>
        <TabsContent value="pruning" className="mt-4"><PruningTab /></TabsContent>
        <TabsContent value="exclude" className="mt-4"><ExcludeTab /></TabsContent>
        <TabsContent value="settings" className="mt-4"><SettingsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
