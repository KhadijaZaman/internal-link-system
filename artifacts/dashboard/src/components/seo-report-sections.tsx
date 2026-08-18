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
import { InfoTip } from "@/components/info-tip";

function HeadTip({ label, tip, right }: { label: string; tip: string; right?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 ${right ? "justify-end" : ""}`}>
      {label}
      <InfoTip>{tip}</InfoTip>
    </span>
  );
}

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
                <TableHead className="text-right"><HeadTip right label="Position" tip="Your average ranking spot in Google for this search (1 = top result, lower is better). Positions 5–15 mean you're close to the top but not there yet." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Impressions" tip="How many times your site appeared in Google results for this search. High impressions = lots of people searching for it." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Clicks" tip="How many people actually clicked through to your site from this search." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Score" tip="Upside score: search volume weighted by how close you are to the top (position × impressions). Higher = bigger traffic win if you improve this ranking. Use it to decide what to work on first." /></TableHead>
                <TableHead><HeadTip label="" tip="'page 2 → 1' marks queries ranking just past position 10 — on page 2 of Google. A small push moves them onto page 1, where nearly all clicks happen." /></TableHead>
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
                <TableHead><HeadTip label="Cluster" tip="A group of related searches that one page (or one hub of pages) can target together, instead of writing a separate article per keyword." /></TableHead>
                <TableHead><HeadTip label="Intent" tip="What the searcher wants. Commercial = ready to compare or buy (good for service/product pages). Informational = looking to learn (good for guides and blog posts)." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Keywords" tip="How many different searches fall into this cluster." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Impressions" tip="Combined number of times your site appeared in Google results across every search in this cluster." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Avg pos" tip="Average Google ranking across the cluster's searches (1 = top, lower is better)." /></TableHead>
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
              <TableHead className="text-right"><HeadTip right label="Impressions" tip="How many times your site appeared in Google for this search. People are searching this — you just don't have a strong page for it yet." /></TableHead>
              <TableHead className="text-right"><HeadTip right label="Position" tip="Where your closest existing page currently ranks (1 = top). A weak position here means no page on your site really answers this search." /></TableHead>
              <TableHead><HeadTip label="Current best page" tip="The page Google currently shows for this search. If it's only loosely related, a dedicated new page would likely rank better." /></TableHead>
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
                  <TableHead><HeadTip label="Issue" tip="The technical problem holding this page back (e.g. not indexed, slow, or blocked). Fixing it removes a handbrake on rankings you've already earned." /></TableHead>
                  <TableHead className="text-right"><HeadTip right label="Clicks at stake" tip="An estimate of the Google clicks this page could gain (or is losing) while the issue remains. Bigger number = fix this one first." /></TableHead>
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
                <TableHead><HeadTip label="Problem" tip="Orphan = no other page on your site links to it, so visitors and Google struggle to find it. Dead-end = it links out to nothing, trapping visitors and ranking value." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="In / out links" tip="In-body internal links pointing to this page / from this page. Navigation and footer links don't count." /></TableHead>
                <TableHead className="text-right"><HeadTip right label="Clicks at stake" tip="Estimated Google clicks this page could gain once it's properly connected to the rest of the site." /></TableHead>
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
              <TableHead><HeadTip label="Domain" tip="A website that links to yours. Links from trusted sites act like votes of confidence for your rankings." /></TableHead>
              <TableHead className="text-right"><HeadTip right label="Domain rank" tip="How authoritative the linking website is, on a 0–1000 scale. Links from higher-ranked domains help your rankings more." /></TableHead>
              <TableHead className="text-right"><HeadTip right label="Backlinks" tip="How many individual links this website points at your site." /></TableHead>
              <TableHead><HeadTip label="Last seen" tip="The most recent date this link was still found live on the other site." /></TableHead>
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
