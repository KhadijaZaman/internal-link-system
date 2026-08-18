import { useState, useMemo, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBacklinkAudit,
  useRunBacklinkAudit,
  useGetBacklinkHistory,
  getGetBacklinkAuditQueryKey,
} from "@workspace/api-client-react";
import type { BacklinkHistoryPoint, BacklinkSummary, TopBacklink, AuditReferringDomain } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { useSiteContext } from "@/lib/site-context";
import {
  scoreAnchor,
  buildDisavowTxt,
  mergeDisavowDomains,
  type DomainRisk,
  type AnchorRisk,
} from "@/lib/backlink-toxicity";
import {
  buildScoredCandidates,
  isDomainFlagged,
  type ScoredDomain,
} from "@/lib/backlink-audit-scoring";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck,
  RefreshCw,
  ExternalLink,
  Anchor,
  Globe2,
  TriangleAlert,
  Download,
  Filter,
  TrendingUp,
  Flag,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
} from "recharts";

function num(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

type HistoryMetric = "rank" | "backlinks" | "referringDomains" | "dofollow";
function FollowBadge({ dofollow }: { dofollow: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        dofollow
          ? "text-xs text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
          : "text-xs text-muted-foreground"
      }
    >
      {dofollow ? "dofollow" : "nofollow"}
    </Badge>
  );
}

function RiskBadge({ risk }: { risk: DomainRisk }) {
  if (risk.level === "low") return null;
  const isHigh = risk.level === "high";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={
            isHigh
              ? "text-xs text-red-700 dark:text-red-400 border-red-500/30 bg-red-500/10 cursor-help"
              : "text-xs text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10 cursor-help"
          }
        >
          <TriangleAlert className="h-3 w-3 mr-1" />
          {isHigh ? "High risk" : "Medium risk"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[260px] text-xs space-y-1">
        {risk.flags.map((f) => (
          <div key={f}>• {f}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function AnchorRiskBadge({ risk }: { risk: AnchorRisk }) {
  if (risk.level === "low") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="text-xs text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10 cursor-help"
        >
          <TriangleAlert className="h-3 w-3 mr-1" />
          Anchor spam
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[260px] text-xs">
        Matched spam phrase: <span className="font-medium">&ldquo;{risk.matchedPhrase}&rdquo;</span>
      </TooltipContent>
    </Tooltip>
  );
}
function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {label}
        {hint ? <InfoTip>{hint}</InfoTip> : null}
      </div>
    </div>
  );
}

function BenchmarkTable({ own, competitors }: { own: BacklinkSummary; competitors: BacklinkSummary[] }) {
  const rows = [own, ...competitors];
  return (
    <div className="border rounded-lg overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead className="text-right">Domain rank</TableHead>
            <TableHead className="text-right">Backlinks</TableHead>
            <TableHead className="text-right">Ref. domains</TableHead>
            <TableHead className="text-right">Dofollow %</TableHead>
            <TableHead className="text-right">Broken</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s, i) => {
            const dfPct = s.backlinks > 0 ? Math.round((s.dofollow / s.backlinks) * 100) : 0;
            return (
              <TableRow key={s.target} className={i === 0 ? "bg-primary/5" : undefined}>
                <TableCell className="text-sm font-medium">
                  {s.target}
                  {i === 0 && (
                    <Badge variant="secondary" className="ml-2 text-xs">
                      you
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{s.rank ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{num(s.backlinks)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{num(s.referringDomains)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{dfPct}%</TableCell>
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {num(s.brokenBacklinks)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
interface ReferringDomainsCardProps {
  referringDomains: AuditReferringDomain[];
  /** Top backlinks used to derive per-domain anchor-text patterns. */
  topBacklinks?: TopBacklink[];
}
export function ReferringDomainsCard({ referringDomains, topBacklinks = [] }: ReferringDomainsCardProps) {
  const { activeSite } = useSiteContext();
  const siteId = activeSite?.id ?? null;
  const storageKey = siteId != null ? disavowStorageKey(siteId) : null;

  const [showFlagged, setShowFlagged] = useState(false);
  const [manualDisavow, setManualDisavow] = useState<Set<string>>(() =>
    storageKey ? loadManualDisavow(storageKey) : new Set()
  );

  // Reload persisted decisions whenever the active site changes.
  useEffect(() => {
    setManualDisavow(storageKey ? loadManualDisavow(storageKey) : new Set());
  }, [storageKey]);

  const toggleManualDisavow = useCallback((domain: string) => {
    setManualDisavow((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      if (storageKey) persistManualDisavow(storageKey, next);
      return next;
    });
  }, [storageKey]);

  // Score all candidates: the referring-domains list (high-backlink-volume
  // bias) extended with any low-authority domains from topBacklinks that
  // aren't already present.  Low-rank domains from the second batch carry
  // anchor data that feeds the anchor-spam toxicity signal.
  const scored = useMemo<ScoredDomain[]>(
    () => buildScoredCandidates(referringDomains, topBacklinks),
    [referringDomains, topBacklinks],
  );

  const flagged = useMemo(() => scored.filter((s) => isDomainFlagged(s.risk)), [scored]);
  const visible = showFlagged ? flagged : scored;

  const totalForExport = useMemo(
    () => mergeDisavowDomains(flagged.map((s) => s.domain.domain), manualDisavow),
    [flagged, manualDisavow],
  );

  const handleExportDisavow = () => {
    const txt = buildDisavowTxt(totalForExport);
    downloadFile("disavow.txt", txt);
  };

  const handleCopy = () =>
    rowsToTsv(
      ["Domain", "Rank", "Backlinks", "First seen"],
      visible.map((s) => [
        s.domain.domain,
        s.domain.rank ?? "",
        s.domain.backlinks,
        s.domain.firstSeen ?? "",
      ]),
    );

  const showExportButton = totalForExport.length > 0 && (showFlagged || manualDisavow.size > 0);

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Globe2 className="h-4 w-4" /> Top referring domains
            <InfoTip>Domains linking to you, ordered by link volume.</InfoTip>
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            {flagged.length > 0 && (
              <Button
                variant={showFlagged ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setShowFlagged((v) => !v)}
                data-testid="button-filter-flagged"
              >
                <Filter className="h-3.5 w-3.5" />
                Flagged
                <Badge
                  variant={showFlagged ? "secondary" : "outline"}
                  className="ml-0.5 text-xs px-1.5 py-0"
                >
                  {flagged.length}
                </Badge>
              </Button>
            )}
            {showExportButton && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 text-red-700 dark:text-red-400 border-red-500/30 hover:bg-red-500/10"
                onClick={handleExportDisavow}
                data-testid="button-export-disavow"
              >
                <Download className="h-3.5 w-3.5" />
                Export disavow.txt
                {totalForExport.length > 0 && (
                  <Badge variant="outline" className="ml-0.5 text-xs px-1.5 py-0">
                    {totalForExport.length}
                  </Badge>
                )}
              </Button>
            )}
            <CopyButton getText={handleCopy} disabled={visible.length === 0} />
          </div>
        </div>

        {showFlagged && flagged.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {flagged.length} domain{flagged.length !== 1 ? "s" : ""} flagged by risk signals.
              {manualDisavow.size > 0 && ` ${manualDisavow.size} additional domain${manualDisavow.size !== 1 ? "s" : ""} manually marked.`}{" "}
              Review carefully before disavowing — legitimate domains can trigger these signals too.
              Export the list and submit it in Google Search Console's Disavow Links tool.
            </span>
          </div>
        )}

        <div className="border rounded-lg overflow-x-auto max-h-[480px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead className="text-right">Rank</TableHead>
                <TableHead className="text-right">Backlinks</TableHead>
                {showFlagged && <TableHead>Risk signals</TableHead>}
                <TableHead className="w-8">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Flag className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs max-w-[200px]">
                      Flag a domain to include it in the disavow export, even if it isn't auto-flagged by risk signals.
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={showFlagged ? 5 : 4} className="text-center text-sm text-muted-foreground py-6">
                    {showFlagged ? "No flagged domains found." : "No referring domains."}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((s) => {
                  const isManual = manualDisavow.has(s.domain.domain);
                  return (
                    <TableRow key={s.domain.domain}>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          {s.domain.domain}
                          <RiskBadge risk={s.risk} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{s.domain.rank ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{num(s.domain.backlinks)}</TableCell>
                      {showFlagged && (
                        <TableCell className="text-xs text-muted-foreground max-w-[280px]">
                          {s.risk.flags.join(" · ")}
                        </TableCell>
                      )}
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`h-6 w-6 p-0 ${isManual ? "text-red-500 hover:text-red-600" : "text-muted-foreground hover:text-foreground"}`}
                          onClick={() => toggleManualDisavow(s.domain.domain)}
                          title={isManual ? "Remove from disavow list" : "Mark for disavowal"}
                          data-testid={`button-toggle-disavow-${s.domain.domain}`}
                        >
                          <Flag className="h-3.5 w-3.5" fill={isManual ? "currentColor" : "none"} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function BacklinkAuditSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetBacklinkAudit();
  const { data: historyData } = useGetBacklinkHistory();
  const history = historyData?.history ?? [];
  const [competitorsInput, setCompetitorsInput] = useState("");

  const run = useRunBacklinkAudit({
    mutation: {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getGetBacklinkAuditQueryKey(), fresh);
        toast({ title: "Backlink audit updated" });
      },
      onError: (err: unknown) => {
        const msg = (err as { data?: { error?: string } })?.data?.error ?? "Audit failed";
        toast({ title: msg, variant: "destructive" });
      },
    },
  });

  const audit = data?.audit ?? null;
  const summary = audit?.summary ?? null;
  const dfPct =
    summary && summary.backlinks > 0
      ? Math.round((summary.dofollow / summary.backlinks) * 100)
      : 0;

  const runAudit = (refresh: boolean) => {
    const competitors = competitorsInput
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    run.mutate({ data: { competitors, refresh } });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-xl flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Backlink Audit
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your complete backlink profile — authority, dofollow quality, anchor
            distribution, and top earned links — benchmarked against competitors.
            Toxic or spammy referring domains are flagged for disavowal.
          </p>
        </div>
        {audit && (
          <div className="text-xs text-muted-foreground">
            Last pulled {new Date(audit.fetchedAt).toLocaleString()}
          </div>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            className="flex gap-2 flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              runAudit(false);
            }}
          >
            <Input
              placeholder="Optional: competitor domains to benchmark, comma-separated"
              value={competitorsInput}
              onChange={(e) => setCompetitorsInput(e.target.value)}
              className="flex-1 min-w-64"
              data-testid="input-audit-competitors"
            />
            <Button type="submit" disabled={run.isPending} className="gap-1.5" data-testid="button-run-audit">
              {run.isPending ? <Spinner className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              {audit ? "Update audit" : "Run audit"}
            </Button>
            {audit && (
              <Button
                type="button"
                variant="outline"
                disabled={run.isPending}
                onClick={() => runAudit(true)}
                className="gap-1.5"
                data-testid="button-refresh-audit"
              >
                <RefreshCw className="h-4 w-4" />
                Force refresh
              </Button>
            )}
          </form>
          <p className="text-xs text-muted-foreground mt-2">
            Pulls the full profile from DataForSEO (paid). Results are saved and
            reused for 24 hours; re-running within that window is free.
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !audit ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No audit yet. Run it to pull your complete backlink profile.
          </CardContent>
        </Card>
      ) : (
        <>
          {summary && (
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <SummaryStat
                    label="Domain rank"
                    value={summary.rank != null ? String(summary.rank) : "—"}
                    hint="DataForSEO domain rank, 0–1000 (comparable to DR)."
                  />
                  <SummaryStat label="Total backlinks" value={num(summary.backlinks)} />
                  <SummaryStat
                    label="Referring domains"
                    value={num(summary.referringDomains)}
                    hint={`${num(summary.referringMainDomains)} unique root domains, ${num(summary.referringIps)} IPs.`}
                  />
                  <SummaryStat label="Dofollow" value={num(summary.dofollow)} />
                  <SummaryStat label="Nofollow" value={num(summary.nofollow)} />
                  <SummaryStat
                    label="Broken backlinks"
                    value={num(summary.brokenBacklinks)}
                    hint="Links pointing to pages that no longer resolve — reclaim these first."
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Dofollow share</span>
                    <span className="tabular-nums">{dfPct}% dofollow</span>
                  </div>
                  <Progress value={dfPct} className="h-2.5" />
                </div>
              </CardContent>
            </Card>
          )}

          <BacklinkGrowthChart history={history} />

          {summary && audit.competitors.length > 0 && (
            <Card>
              <CardContent className="pt-5 space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-1.5">
                  <Globe2 className="h-4 w-4" /> Competitor benchmark
                </h3>
                <BenchmarkTable own={summary} competitors={audit.competitors} />
              </CardContent>
            </Card>
          )}

          <div className="grid xl:grid-cols-2 gap-4 items-start">
            <Card>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium flex items-center gap-1.5">
                    <Anchor className="h-4 w-4" /> Top anchors
                    <InfoTip>
                      Anchor-text distribution across your backlink profile. A
                      healthy profile is dominated by branded and URL anchors.
                    </InfoTip>
                  </h3>
                  <CopyButton
                    getText={() =>
                      rowsToTsv(
                        ["Anchor", "Backlinks", "Ref. domains", "Dofollow", "Nofollow"],
                        audit.anchors.map((a) => [
                          a.anchor || "(empty)",
                          a.backlinks,
                          a.referringDomains,
                          a.dofollow,
                          a.nofollow,
                        ]),
                      )
                    }
                    disabled={audit.anchors.length === 0}
                  />
                </div>
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Anchor</TableHead>
                        <TableHead className="text-right">Backlinks</TableHead>
                        <TableHead className="text-right">Ref. domains</TableHead>
                        <TableHead className="text-right">Dofollow</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.anchors.map((a) => {
                        const anchorRisk = scoreAnchor(a.anchor ?? "");
                        return (
                          <TableRow key={a.anchor || "(empty)"}>
                            <TableCell className="text-sm max-w-[280px]">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="truncate" title={a.anchor}>
                                  {a.anchor || <span className="text-muted-foreground">(empty)</span>}
                                </span>
                                <AnchorRiskBadge risk={anchorRisk} />
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{num(a.backlinks)}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{num(a.referringDomains)}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{num(a.dofollow)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <ReferringDomainsCard
              referringDomains={audit.referringDomains}
              topBacklinks={audit.topBacklinks}
            />
          </div>

          <Card>
            <CardContent className="pt-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium flex items-center gap-1.5">
                  <ExternalLink className="h-4 w-4" /> Core earned backlinks
                  <InfoTip>
                    Your strongest backlinks — one per referring domain, ordered
                    by the linking domain's authority.
                  </InfoTip>
                </h3>
                <CopyButton
                  getText={() =>
                    rowsToTsv(
                      ["Source", "Domain rank", "Anchor", "Follow", "Target"],
                      audit.topBacklinks.map((b: TopBacklink) => [
                        b.urlFrom,
                        b.domainFromRank ?? "",
                        b.anchor ?? "",
                        b.dofollow ? "dofollow" : "nofollow",
                        b.urlTo,
                      ]),
                    )
                  }
                  disabled={audit.topBacklinks.length === 0}
                />
              </div>
              <div className="border rounded-lg overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source page</TableHead>
                      <TableHead className="text-right">Domain rank</TableHead>
                      <TableHead>Anchor</TableHead>
                      <TableHead>Follow</TableHead>
                      <TableHead>Links to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.topBacklinks.map((b) => {
                      const anchorRisk = scoreAnchor(b.anchor ?? "");
                      return (
                        <TableRow key={b.urlFrom}>
                          <TableCell className="max-w-[340px]">
                            <a
                              href={b.urlFrom}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="text-sm hover:underline truncate block"
                              title={b.pageFromTitle ?? b.urlFrom}
                            >
                              {b.pageFromTitle || b.domainFrom}
                            </a>
                            <div className="text-xs text-muted-foreground truncate">{b.domainFrom}</div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {b.domainFromRank ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm max-w-[220px]">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="truncate" title={b.anchor ?? undefined}>
                                {b.anchor || <span className="text-muted-foreground">(no anchor)</span>}
                              </span>
                              <AnchorRiskBadge risk={anchorRisk} />
                            </div>
                          </TableCell>
                          <TableCell>
                            <FollowBadge dofollow={b.dofollow} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={b.urlTo}>
                            {b.urlTo}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MiniSparkline({
  data,
  metric,
}: {
  data: BacklinkHistoryPoint[];
  metric: HistoryMetric;
}) {
  const hasData = data.some((d) => d[metric] != null);
  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
        No data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={64}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <XAxis dataKey="date" hide />
        <YAxis domain={["auto", "auto"]} hide />
        <RechartsTooltip
          contentStyle={{ fontSize: "11px", padding: "4px 8px" }}
          labelFormatter={(v: unknown) => String(v)}
          formatter={(v: number) => [v.toLocaleString(), METRIC_LABELS[metric]]}
        />
        <Line
          type="monotone"
          dataKey={metric}
          stroke={METRIC_COLORS[metric]}
          strokeWidth={1.5}
          dot={data.length <= 14}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

const METRIC_COLORS: Record<HistoryMetric, string> = {
  rank: "hsl(var(--primary))",
  backlinks: "#10b981",
  referringDomains: "#6366f1",
  dofollow: "#f59e0b",
};

function BacklinkGrowthChart({ history }: { history: BacklinkHistoryPoint[] }) {
  if (history.length < 2) return null;

  const metrics: HistoryMetric[] = ["rank", "backlinks", "referringDomains", "dofollow"];

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4" /> Authority growth
          <InfoTip>
            Day-by-day trend of key backlink metrics captured each time you run
            the audit. Needs at least 2 data points to display.
          </InfoTip>
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {metrics.map((m) => (
            <div key={m} className="space-y-1">
              <div className="text-xs text-muted-foreground">{METRIC_LABELS[m]}</div>
              <MiniSparkline data={history} metric={m} />
            </div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          {history.length} snapshot{history.length !== 1 ? "s" : ""} recorded
          · first {history[0]!.date} · latest {history[history.length - 1]!.date}
        </div>
      </CardContent>
    </Card>
  );
}

const METRIC_LABELS: Record<HistoryMetric, string> = {
  rank: "Domain rank",
  backlinks: "Backlinks",
  referringDomains: "Ref. domains",
  dofollow: "Dofollow",
};

export function disavowStorageKey(siteId: number): string {
  return `linkweave:disavow:manual:${siteId}`;
}
export function loadManualDisavow(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function persistManualDisavow(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — silently skip */
  }
}
