import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBacklinkAudit,
  useRunBacklinkAudit,
  getGetBacklinkAuditQueryKey,
} from "@workspace/api-client-react";
import type { BacklinkSummary, TopBacklink } from "@workspace/api-client-react";
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
import { InfoTip } from "@/components/info-tip";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, RefreshCw, ExternalLink, Anchor, Globe2 } from "lucide-react";

function num(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

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

export function BacklinkAuditSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetBacklinkAudit();
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
                      {audit.anchors.map((a) => (
                        <TableRow key={a.anchor || "(empty)"}>
                          <TableCell className="text-sm max-w-[280px] truncate" title={a.anchor}>
                            {a.anchor || <span className="text-muted-foreground">(empty)</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{num(a.backlinks)}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{num(a.referringDomains)}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{num(a.dofollow)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium flex items-center gap-1.5">
                    <Globe2 className="h-4 w-4" /> Top referring domains
                    <InfoTip>Domains linking to you, ordered by link volume.</InfoTip>
                  </h3>
                  <CopyButton
                    getText={() =>
                      rowsToTsv(
                        ["Domain", "Rank", "Backlinks", "First seen"],
                        audit.referringDomains.map((d) => [
                          d.domain,
                          d.rank ?? "",
                          d.backlinks,
                          d.firstSeen ?? "",
                        ]),
                      )
                    }
                    disabled={audit.referringDomains.length === 0}
                  />
                </div>
                <div className="border rounded-lg overflow-x-auto max-h-[480px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead className="text-right">Rank</TableHead>
                        <TableHead className="text-right">Backlinks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.referringDomains.map((d) => (
                        <TableRow key={d.domain}>
                          <TableCell className="text-sm">{d.domain}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{d.rank ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{num(d.backlinks)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
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
                    {audit.topBacklinks.map((b) => (
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
                        <TableCell className="text-sm max-w-[220px] truncate" title={b.anchor ?? undefined}>
                          {b.anchor || <span className="text-muted-foreground">(no anchor)</span>}
                        </TableCell>
                        <TableCell>
                          <FollowBadge dofollow={b.dofollow} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={b.urlTo}>
                          {b.urlTo}
                        </TableCell>
                      </TableRow>
                    ))}
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
