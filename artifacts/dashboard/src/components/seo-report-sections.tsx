import { Link } from "wouter";
import { useGetSeoReport } from "@workspace/api-client-react";
import type { SeoReportResponse } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowRight } from "lucide-react";

function fmt(n: number): string {
  return n.toLocaleString();
}

function SectionCard({
  n,
  title,
  subtitle,
  linkHref,
  linkLabel,
  note,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  linkHref: string;
  linkLabel: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={`report-section-${n}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {n}
            </span>
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
            </div>
          </div>
          <Link href={linkHref}>
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0">
              {linkLabel}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function NearMissSection({ data }: { data: SeoReportResponse["nearMiss"] }) {
  return (
    <SectionCard
      n={1}
      title="Near-miss keywords"
      subtitle="Queries stuck at position 5–15 with solid impressions, ranked by position × volume. Page 2 → page 1 candidates flagged."
      linkHref="/keyword-report"
      linkLabel="Keyword Report"
      note={data.note}
    >
      {!data.available || data.queries.length === 0 ? (
        <Empty text={data.available ? "No near-miss queries in the last 28 days." : "Not available."} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{fmt(data.totalCandidates)}</span> queries sit
            just below the top results ({data.windowStart} → {data.windowEnd}). The top {data.queries.length} by
            upside:
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Query</TableHead>
                <TableHead className="text-right">Position</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.queries.map((q) => (
                <TableRow key={q.query}>
                  <TableCell className="font-medium max-w-64 truncate" title={q.bestPath ?? undefined}>
                    {q.query}
                  </TableCell>
                  <TableCell className="text-right">{q.position}</TableCell>
                  <TableCell className="text-right">{fmt(q.impressions)}</TableCell>
                  <TableCell className="text-right">{fmt(q.clicks)}</TableCell>
                  <TableCell className="text-right">{fmt(q.score)}</TableCell>
                  <TableCell>
                    {q.page2 ? <Badge variant="secondary">page 2 → 1</Badge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SectionCard>
  );
}

function ClustersSection({ data }: { data: SeoReportResponse["clusters"] }) {
  return (
    <SectionCard
      n={2}
      title="Keywords grouped by intent"
      subtitle="Scattered seed terms turned into hub-and-spoke clusters — commercial and informational, separated."
      linkHref="/clustering"
      linkLabel="Keyword Clusters"
      note={data.note}
    >
      {!data.available || data.clusters.length === 0 ? (
        <Empty text="No completed clustering run yet." />
      ) : (
        <>
          <div className="flex gap-2">
            <Badge>{data.commercialCount} commercial</Badge>
            <Badge variant="secondary">{data.informationalCount} informational</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cluster</TableHead>
                <TableHead>Intent</TableHead>
                <TableHead className="text-right">Keywords</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Avg pos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.clusters.map((c) => (
                <TableRow key={c.topic}>
                  <TableCell className="font-medium max-w-64 truncate">{c.topic}</TableCell>
                  <TableCell>
                    <Badge variant={c.intent === "commercial" ? "default" : "secondary"}>{c.intent}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{fmt(c.keywordCount)}</TableCell>
                  <TableCell className="text-right">{fmt(c.totalImpressions)}</TableCell>
                  <TableCell className="text-right">{c.avgPosition ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SectionCard>
  );
}

function ContentGapsSection({ data }: { data: SeoReportResponse["contentGaps"] }) {
  return (
    <SectionCard
      n={3}
      title="Gaps ready to become drafts"
      subtitle="Queries with real demand where you rank too deep to matter — draft candidates straight from GSC, not hunches."
      linkHref="/content/writer"
      linkLabel="Content Writer"
      note={data.note}
    >
      {!data.available || data.gaps.length === 0 ? (
        <Empty text={data.available ? "No high-demand gaps detected in the last 28 days." : "Not available."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Query</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Position</TableHead>
              <TableHead>Current best page</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.gaps.map((g) => (
              <TableRow key={g.query}>
                <TableCell className="font-medium max-w-64 truncate">{g.query}</TableCell>
                <TableCell className="text-right">{fmt(g.impressions)}</TableCell>
                <TableCell className="text-right">{g.position}</TableCell>
                <TableCell className="max-w-64 truncate text-muted-foreground">{g.bestPath ?? "none"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function TechDebtSection({ data }: { data: SeoReportResponse["techDebt"] }) {
  return (
    <SectionCard
      n={4}
      title="Technical debt"
      subtitle="Broken links, redirecting internal links, and unindexed pages — ranked by the traffic at stake."
      linkHref="/gsc/indexing"
      linkLabel="Indexing & CWV"
      note={data.note}
    >
      {!data.available ? (
        <Empty text="No crawl audits recorded yet." />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {data.audits.map((a) => (
              <Badge key={a.type} variant="secondary">
                {a.type.replace(/_/g, " ")}: {fmt(a.itemCount)}
              </Badge>
            ))}
            <Badge variant="outline">{fmt(data.notIndexedCount)} pages with zero impressions</Badge>
          </div>
          {data.topPagesAtRisk.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead className="text-right">Clicks at stake</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topPagesAtRisk.map((p) => (
                  <TableRow key={`${p.path}|${p.issue}`}>
                    <TableCell className="font-medium max-w-64 truncate">{p.path}</TableCell>
                    <TableCell className="text-muted-foreground">{p.issue}</TableCell>
                    <TableCell className="text-right">{fmt(p.clicks)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

function LinkGapsSection({ data }: { data: SeoReportResponse["linkGaps"] }) {
  return (
    <SectionCard
      n={5}
      title="Internal linking gaps"
      subtitle="Orphan and dead-end pages spotted instantly — the ranking lever everyone skips."
      linkHref="/links/structural"
      linkLabel="Structural Fixes"
      note={data.note}
    >
      {data.items.length === 0 ? (
        <Empty text="No orphan or dead-end pages in the latest crawl." />
      ) : (
        <>
          <div className="flex gap-2">
            <Badge variant="destructive">{data.orphanCount} orphans</Badge>
            <Badge variant="secondary">{data.deadEndCount} dead ends</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Page</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead className="text-right">In / out links</TableHead>
                <TableHead className="text-right">Clicks at stake</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((i) => (
                <TableRow key={i.url}>
                  <TableCell className="font-medium max-w-64 truncate" title={i.url}>
                    {i.title ?? i.url}
                  </TableCell>
                  <TableCell>
                    {i.isOrphan ? <Badge variant="destructive">orphan</Badge> : null}{" "}
                    {i.isDeadEnd ? <Badge variant="secondary">dead end</Badge> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {i.inboundCount} / {i.outboundCount}
                  </TableCell>
                  <TableCell className="text-right">{fmt(i.clicks)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SectionCard>
  );
}

function BacklinksSection({ data }: { data: SeoReportResponse["backlinks"] }) {
  return (
    <SectionCard
      n={6}
      title="Backlink profile"
      subtitle="Referring domains scored by domain rank — outreach targets and cleanup candidates in one list."
      linkHref="/gsc/links"
      linkLabel="Links Report"
      note={data.note}
    >
      {!data.available || data.domains.length === 0 ? (
        <Empty text="No backlink data available." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead className="text-right">Domain rank</TableHead>
              <TableHead className="text-right">Backlinks</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.domains.map((d) => (
              <TableRow key={d.domain}>
                <TableCell className="font-medium max-w-64 truncate">{d.domain}</TableCell>
                <TableCell className="text-right">{d.rank ?? "—"}</TableCell>
                <TableCell className="text-right">{fmt(d.backlinks)}</TableCell>
                <TableCell className="text-muted-foreground">{d.lastSeen ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function WeeklySection({ data }: { data: SeoReportResponse["weekly"] }) {
  return (
    <SectionCard
      n={7}
      title="Weekly movement"
      subtitle="Position shifts, completed work, and this week's priorities — you know what moved before anyone asks."
      linkHref="/digest"
      linkLabel="Weekly Digest"
      note={data.note}
    >
      {!data.available ? (
        <Empty text="No weekly digest yet." />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">week of {data.weekOf}</Badge>
            {data.healthCurrent != null ? (
              <Badge variant="secondary">
                health {data.healthCurrent}
                {data.healthDelta != null && data.healthDelta !== 0
                  ? ` (${data.healthDelta > 0 ? "+" : ""}${data.healthDelta})`
                  : ""}
              </Badge>
            ) : null}
            <Badge variant="secondary">{data.winsImproved} pages improved</Badge>
            <Badge variant="secondary">{data.winsDeclined} declined</Badge>
            <Badge variant="secondary">{data.newIssues} new issues</Badge>
            <Badge variant="secondary">{data.completed} completed</Badge>
            <Badge variant="outline">{data.openActions} open actions</Badge>
          </div>
          {data.priorities.length > 0 ? (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                Top priorities
              </div>
              <ol className="list-decimal pl-5 text-sm space-y-1">
                {data.priorities.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

export function SeoReportSections() {
  const { data, isLoading, error } = useGetSeoReport();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <p className="text-sm text-muted-foreground">
        The full report could not be loaded right now. Try again in a minute.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <NearMissSection data={data.nearMiss} />
      <ClustersSection data={data.clusters} />
      <ContentGapsSection data={data.contentGaps} />
      <TechDebtSection data={data.techDebt} />
      <LinkGapsSection data={data.linkGaps} />
      <BacklinksSection data={data.backlinks} />
      <WeeklySection data={data.weekly} />
    </div>
  );
}
