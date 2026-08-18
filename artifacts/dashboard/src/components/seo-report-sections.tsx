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

/** Right-aligned column header with a plain-English tooltip. */
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

/** Percentage with one decimal, e.g. 3.4%. Input is a fraction unless `isPct`. */
function pct(v: number | null | undefined, isPct = false): string {
  if (v == null) return "—";
  const n = isPct ? v : v * 100;
  return `${n.toFixed(1)}%`;
}

/** CTR ratio like ×0.4 (actual clicks vs. what the position should earn). */
function ratio(v: number): string {
  return `×${v.toFixed(1)}`;
}

/** Average engagement time in seconds → e.g. 1m 42s. */
function duration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/** Average ranking position, one decimal. */
function pos(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(1);
}

function GroupIntro({
  title,
  source,
  intro,
  trap,
}: {
  title: string;
  source: string;
  intro: string;
  trap?: string;
}) {
  return (
    <div className="pt-2">
      <div className="flex items-baseline gap-2">
        <h3 className="font-display text-lg">{title}</h3>
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{source}</span>
      </div>
      <p className="text-sm text-muted-foreground mt-1">{intro}</p>
      {trap ? <p className="text-xs text-muted-foreground mt-1 italic">{trap}</p> : null}
    </div>
  );
}

function SectionCard({
  n,
  title,
  subtitle,
  linkHref,
  linkLabel,
  note,
  available,
  emptyText,
  isEmpty,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  linkHref: string;
  linkLabel: string;
  note?: string | null;
  available: boolean;
  emptyText: string;
  isEmpty: boolean;
  children?: React.ReactNode;
}) {
  const showEmpty = !available || isEmpty;
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
        {showEmpty ? (
          <div className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              {!available ? note ?? "Not available yet." : emptyText}
            </p>
          </div>
        ) : (
          <>
            {children}
            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Small muted caption for the "traps" the user must remember. */
function Trap({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground italic">{children}</p>;
}

/* -------------------------------------------------------------------------- */
/* Group 1 — What the demand data says (Google Search Console)                */
/* -------------------------------------------------------------------------- */

function QueryIntegritySection({ data }: { data: SeoReportResponse["queryIntegrity"] }) {
  return (
    <SectionCard
      n={1}
      title="One query, multiple pages"
      subtitle="When several of your pages compete for the same search, they split the clicks — pick one page to own it and point the rest at it."
      linkHref="/gsc/queries"
      linkLabel="Query Report"
      note={data.note}
      available={data.available}
      isEmpty={data.rows.length === 0}
      emptyText="No overlapping queries found — each search maps cleanly to one page."
    >
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{fmt(data.totalCount)}</span> searches send
        Google traffic to more than one of your pages. The most contested:
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Query"
                tip="The exact thing people typed into Google. Several of your pages show up for it, so they compete with each other."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Impressions"
                tip="How many times any of your pages appeared for this search. High = lots of demand worth consolidating onto one strong page."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Clicks"
                tip="Total clicks this search sent you, spread across the competing pages below."
              />
            </TableHead>
            <TableHead>
              <HeadTip
                label="Competing pages (share)"
                tip="The pages Google shows for this search and how the impressions split between them. The share is only within these pages — see the caption below."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => (
            <TableRow key={r.query}>
              <TableCell className="font-medium max-w-48 truncate" title={r.query}>
                {r.query}
              </TableCell>
              <TableCell className="text-right">{fmt(r.impressions)}</TableCell>
              <TableCell className="text-right">{fmt(r.clicks)}</TableCell>
              <TableCell className="max-w-sm">
                <div className="space-y-0.5">
                  {r.urls.map((u) => (
                    <div key={u.path} className="flex items-center gap-2 text-xs">
                      <span className="truncate text-muted-foreground" title={u.path}>
                        {u.path}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {pct(u.sharePct, true)} · p{pos(u.position)}
                      </span>
                    </div>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Trap>
        Google hides low-volume queries, so shares are within the listed pages only, never of your
        total.
      </Trap>
    </SectionCard>
  );
}

function CtrCurveTable({
  rows,
  kind,
}: {
  rows: SeoReportResponse["ctrCurve"]["belowCurve"];
  kind: "below" | "above";
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <HeadTip
              label="Page"
              tip="The page that's under- or over-performing for its ranking. The path is truncated — hover to see it in full."
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label="Position"
              tip="Where this page ranks in Google on average (1 = top). Combined with clicks, it tells us whether the snippet is doing its job."
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label="CTR vs expected"
              tip={
                kind === "below"
                  ? "Actual click-through rate compared to what a page at this position normally earns. ×0.4 means it gets 40% of the clicks it should — a title/snippet problem, not a ranking one."
                  : "Actual click-through rate vs. the norm for this position. Above ×1 means the snippet is a magnet — rank it higher and every extra spot compounds."
              }
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label={kind === "below" ? "Missed clicks" : "Clicks"}
              tip={
                kind === "below"
                  ? "Roughly how many clicks you'd win per period if the snippet performed like an average result at this position. Fix the highest ones first."
                  : "Clicks this page already earns. Pushing its ranking up is high leverage because the snippet already converts."
              }
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.path}>
            <TableCell className="font-medium max-w-64 truncate" title={r.path}>
              {r.path}
            </TableCell>
            <TableCell className="text-right">{pos(r.position)}</TableCell>
            <TableCell className="text-right tabular-nums">{ratio(r.ratio)}</TableCell>
            <TableCell className="text-right">
              {kind === "below" ? fmt(r.missedClicks) : fmt(r.clicks)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CtrCurveSection({ data }: { data: SeoReportResponse["ctrCurve"] }) {
  const isEmpty = data.belowCurve.length === 0 && data.aboveCurve.length === 0;
  return (
    <SectionCard
      n={2}
      title="Click-through vs. what your position should earn"
      subtitle="Some pages rank fine but get skipped in the results — that's a snippet problem you can fix in minutes, not a content one."
      linkHref="/keyword-report"
      linkLabel="Keyword Report"
      note={data.note}
      available={data.available}
      isEmpty={isEmpty}
      emptyText="No pages meaningfully off the click-through curve right now."
    >
      {data.belowCurve.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Below the curve — rewrite the title/snippet, not the content
          </p>
          <CtrCurveTable rows={data.belowCurve} kind="below" />
        </div>
      ) : null}
      {data.aboveCurve.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Above the curve — ranking higher is high leverage
          </p>
          <CtrCurveTable rows={data.aboveCurve} kind="above" />
        </div>
      ) : null}
      <Trap>
        A page below the curve has a title/snippet problem, not a ranking problem. If rankings are
        flat but clicks dropped, check the search page for new features before touching content.
      </Trap>
    </SectionCard>
  );
}

function StrikingDistanceSection({ data }: { data: SeoReportResponse["strikingDistance"] }) {
  return (
    <SectionCard
      n={3}
      title="Biggest wins within reach"
      subtitle="Searches where a small ranking nudge unlocks the most traffic — the shortlist of what to work on first."
      linkHref="/keyword-report"
      linkLabel="Keyword Report"
      note={data.note}
      available={data.available}
      isEmpty={data.queries.length === 0}
      emptyText="No high-upside near-miss queries in this window."
    >
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{fmt(data.totalCandidates)}</span> queries sit
        just below the top results
        {data.windowStart && data.windowEnd ? ` (${data.windowStart} → ${data.windowEnd})` : ""}.
        Ranked by impressions × closeness, not position alone:
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Query"
                tip="The search you're close to winning. Hover the row to see the page best positioned to capture it."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Position"
                tip="Your average ranking spot (1 = top). Positions 5–15 mean you're close but not there yet."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Impressions"
                tip="How often you appeared for this search. High volume is why a small ranking gain here pays off."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Score"
                tip="Upside ranked by search volume weighted by how close you already are — not by position alone. Higher = bigger, easier win. Start at the top."
              />
            </TableHead>
            <TableHead>
              <HeadTip
                label=""
                tip="'page 2 → 1' marks queries ranking just past position 10. A small push moves them onto page 1, where nearly all clicks happen."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.queries.map((q) => (
            <TableRow key={q.query}>
              <TableCell className="font-medium max-w-64 truncate" title={q.bestPath ?? undefined}>
                {q.query}
              </TableCell>
              <TableCell className="text-right">{pos(q.position)}</TableCell>
              <TableCell className="text-right">{fmt(q.impressions)}</TableCell>
              <TableCell className="text-right">{fmt(q.score)}</TableCell>
              <TableCell>{q.page2 ? <Badge variant="secondary">page 2 → 1</Badge> : null}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function QueryDiscoveryTable({
  rows,
  kind,
}: {
  rows: SeoReportResponse["queryDiscovery"]["gainers"];
  kind: "gainers" | "losers";
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <HeadTip
              label="Page"
              tip="A page on your site. We count how many distinct searches it shows up for — its search footprint."
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label="Queries now"
              tip="How many different searches this page currently ranks for. Growing means Google trusts it for more topics."
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label="Before"
              tip="The same count from the earlier date, so you can see the direction of travel."
            />
          </TableHead>
          <TableHead className="text-right">
            <HeadTip
              right
              label="Change"
              tip={
                kind === "gainers"
                  ? "Net new searches this page picked up. A rising footprint usually precedes rising clicks — keep feeding these pages."
                  : "Searches this page lost. A shrinking footprint is an early warning to refresh or re-link the page before clicks fall."
              }
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.path}>
            <TableCell className="font-medium max-w-64 truncate" title={r.path}>
              {r.path}
            </TableCell>
            <TableCell className="text-right">{fmt(r.queriesNow)}</TableCell>
            <TableCell className="text-right">{fmt(r.queriesBefore)}</TableCell>
            <TableCell
              className={`text-right tabular-nums ${
                r.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : r.delta < 0 ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              {r.delta > 0 ? "+" : ""}
              {fmt(r.delta)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function QueryDiscoverySection({ data }: { data: SeoReportResponse["queryDiscovery"] }) {
  const isEmpty = data.gainers.length === 0 && data.losers.length === 0;
  return (
    <SectionCard
      n={4}
      title="Is your coverage expanding?"
      subtitle="Whether your pages are ranking for more searches over time or quietly losing ground — a leading indicator of traffic before it moves."
      linkHref="/gsc/queries"
      linkLabel="Query Report"
      note={data.note}
      available={data.available}
      isEmpty={isEmpty}
      emptyText="Not enough history yet to compare search coverage."
    >
      {data.dateBefore && data.dateNow ? (
        <p className="text-sm text-muted-foreground">
          Distinct searches per page, {data.dateBefore} → {data.dateNow}.
        </p>
      ) : null}
      {data.gainers.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Gaining coverage</p>
          <QueryDiscoveryTable rows={data.gainers} kind="gainers" />
        </div>
      ) : null}
      {data.losers.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Losing coverage</p>
          <QueryDiscoveryTable rows={data.losers} kind="losers" />
        </div>
      ) : null}
    </SectionCard>
  );
}

function IndexingByTemplateSection({ data }: { data: SeoReportResponse["indexingByTemplate"] }) {
  return (
    <SectionCard
      n={5}
      title="Indexing health by template"
      subtitle="When a whole section of the site earns no impressions, it's usually a structural or template problem — not weak content on each page."
      linkHref="/gsc/indexing"
      linkLabel="Indexing & CWV"
      note={data.note}
      available={data.available}
      isEmpty={data.sections.length === 0}
      emptyText="No template-level indexing gaps detected."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Section"
                tip="A group of pages built from the same template (e.g. blog posts, product pages). Problems here tend to hit the whole group at once."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Pages"
                tip="How many pages exist in this section."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Seen by Google"
                tip="How many of those pages actually appeared in search at least once. A big gap points at a template or indexing issue."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Zero impressions"
                tip="Share of the section that Google never showed. High here means fix the template or internal links, not the copy — check this section before rewriting pages."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.sections.map((s) => (
            <TableRow key={s.section ?? "(none)"}>
              <TableCell className="font-medium max-w-64 truncate" title={s.section ?? undefined}>
                {s.section ?? "Uncategorised"}
              </TableCell>
              <TableCell className="text-right">{fmt(s.totalPages)}</TableCell>
              <TableCell className="text-right">{fmt(s.pagesWithImpressions)}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${
                  s.zeroImpressionPct >= 50 ? "text-red-600 dark:text-red-400" : ""
                }`}
              >
                {pct(s.zeroImpressionPct, true)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Group 2 — What the click was worth (GSC × GA4 joins)                       */
/* -------------------------------------------------------------------------- */

function InvestMapSection({ data }: { data: SeoReportResponse["investMap"] }) {
  return (
    <SectionCard
      n={6}
      title="Where to invest"
      subtitle="The pages that don't just get clicks but actually convert — spend your time here, because rankings on these compound into results."
      linkHref="/ga4/pages"
      linkLabel="Page Analytics"
      note={data.note}
      available={data.available}
      isEmpty={data.pages.length === 0}
      emptyText="No pages with both search traffic and conversions to rank yet."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Page"
                tip="A page that earns search clicks AND drives real outcomes. Hover for the full path and top query."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Clicks"
                tip="Google search clicks (from GSC). Counted differently from sessions — see the group note."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Sessions"
                tip="Visits recorded by GA4. Not the same as clicks — the two are shown side by side, never combined."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Engaged"
                tip="Share of visits where the visitor actually stuck around and interacted. Higher means the page delivers on the search."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Conversions"
                tip="Key events (sign-ups, purchases, leads) this page produced. This is why it's worth investing in — traffic that pays off."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.pages.map((p) => (
            <TableRow key={p.path}>
              <TableCell className="font-medium max-w-64 truncate" title={p.topQuery ?? p.path}>
                {p.title ?? p.path}
              </TableCell>
              <TableCell className="text-right">{fmt(p.clicks)}</TableCell>
              <TableCell className="text-right">{fmt(p.sessions)}</TableCell>
              <TableCell className="text-right">{pct(p.engagementRate, true)}</TableCell>
              <TableCell className="text-right font-medium">{fmt(p.keyEvents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function TitleRewritesSection({ data }: { data: SeoReportResponse["titleRewrites"] }) {
  return (
    <SectionCard
      n={7}
      title="Rewrite titles, not content"
      subtitle="Searchers see these pages but skip them — yet the few who click go on to convert, so a better title is the whole fix."
      linkHref="/ga4/pages"
      linkLabel="Page Analytics"
      note={data.note}
      available={data.available}
      isEmpty={data.pages.length === 0}
      emptyText="No high-converting pages held back by weak titles right now."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Page"
                tip="A page that converts well but gets skipped in the results. The lever is the title/snippet, not the page itself."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Position"
                tip="Where it ranks (1 = top). It's already visible enough — the snippet just isn't earning the click."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="CTR vs expected"
                tip="Actual click-through rate vs. the norm for this position. Below ×1 means the title/snippet is leaving clicks on the table."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Missed clicks"
                tip="Roughly how many clicks a better snippet would win here. Because these pages convert, those clicks turn into outcomes — rewrite the biggest first."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Conversions"
                tip="Key events the page already drives from its small traffic — proof the rewrite is worth it."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.pages.map((p) => (
            <TableRow key={p.path}>
              <TableCell className="font-medium max-w-64 truncate" title={p.path}>
                {p.title ?? p.path}
              </TableCell>
              <TableCell className="text-right">{pos(p.position)}</TableCell>
              <TableCell className="text-right tabular-nums">{ratio(p.actualCtr / (p.expectedCtr || 1))}</TableCell>
              <TableCell className="text-right">{fmt(p.missedClicks)}</TableCell>
              <TableCell className="text-right font-medium">{fmt(p.keyEvents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function WrongIntentSection({ data }: { data: SeoReportResponse["wrongIntent"] }) {
  return (
    <SectionCard
      n={8}
      title="Ranking for the wrong reason"
      subtitle="Clicks arrive but nobody engages or converts — usually you're ranking for a search that doesn't match what the page offers."
      linkHref="/ga4/pages"
      linkLabel="Page Analytics"
      note={data.note}
      available={data.available}
      isEmpty={data.pages.length === 0}
      emptyText="No obvious intent mismatches detected."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Page"
                tip="A page pulling in search traffic that bounces straight off. Something about the match is wrong."
              />
            </TableHead>
            <TableHead>
              <HeadTip
                label="Top query"
                tip="The search sending the most clicks. If it doesn't match what the page delivers, that's the mismatch — retarget the page or the query."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Clicks"
                tip="Search clicks arriving on the page. Plenty of traffic — the problem is what happens after the click."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Engaged"
                tip="Share of visits that actually interact. Low here confirms the click didn't get what it came for."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Time on page"
                tip="Average engaged time per visit. Very short means visitors bounce — reframe the page to match the search, or chase a better-matched query."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.pages.map((p) => (
            <TableRow key={p.path}>
              <TableCell className="font-medium max-w-56 truncate" title={p.path}>
                {p.title ?? p.path}
              </TableCell>
              <TableCell className="max-w-48 truncate text-muted-foreground" title={p.topQuery ?? undefined}>
                {p.topQuery ?? "—"}
              </TableCell>
              <TableCell className="text-right">{fmt(p.clicks)}</TableCell>
              <TableCell className="text-right">{pct(p.engagementRate, true)}</TableCell>
              <TableCell className="text-right">{duration(p.avgEngagementTime)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Group 3 — Demand Google never shows you (Bing)                             */
/* -------------------------------------------------------------------------- */

function BingOnlyQueriesSection({ data }: { data: SeoReportResponse["bingOnlyQueries"] }) {
  return (
    <SectionCard
      n={9}
      title="Demand Google never shows you"
      subtitle="Searches that drive impressions on Bing but are invisible in Google — a demand signal you'd otherwise miss entirely."
      linkHref="/bing"
      linkLabel="Bing & AI Citations"
      note={data.note}
      available={data.available}
      isEmpty={data.queries.length === 0}
      emptyText="No Bing-only queries yet — connect Bing in Settings to see this."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <HeadTip
                label="Query"
                tip="A search where Bing shows you real demand that never surfaces in your Google data. Worth checking whether Google is simply hiding it."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Impressions"
                tip="How often you appeared for this search on Bing. Bing traffic skews to different users — treat it as extra demand, not a Google comparison."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Clicks"
                tip="Clicks this search sent you from Bing."
              />
            </TableHead>
            <TableHead className="text-right">
              <HeadTip
                right
                label="Position"
                tip="Your average Bing ranking for this search (1 = top)."
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.queries.map((q) => (
            <TableRow key={q.query}>
              <TableCell className="font-medium max-w-64 truncate" title={q.query}>
                {q.query}
              </TableCell>
              <TableCell className="text-right">{fmt(q.impressions)}</TableCell>
              <TableCell className="text-right">{fmt(q.clicks)}</TableCell>
              <TableCell className="text-right">{pos(q.position)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */

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
      <GroupIntro
        title="What the demand data says"
        source="Google Search Console"
        intro="How Google actually shows your site: which searches want you, where a nudge pays off, and whether your reach is growing."
      />
      <QueryIntegritySection data={data.queryIntegrity} />
      <CtrCurveSection data={data.ctrCurve} />
      <StrikingDistanceSection data={data.strikingDistance} />
      <QueryDiscoverySection data={data.queryDiscovery} />
      <IndexingByTemplateSection data={data.indexingByTemplate} />

      <GroupIntro
        title="What the click was worth"
        source="Google Search Console × GA4"
        intro="Search clicks joined to what visitors actually did — so effort goes to pages that pay off, not just pages that rank."
        trap="Search clicks (Google) and sessions (GA4) are counted differently and never reconcile — they're shown side by side, never combined."
      />
      <InvestMapSection data={data.investMap} />
      <TitleRewritesSection data={data.titleRewrites} />
      <WrongIntentSection data={data.wrongIntent} />

      <GroupIntro
        title="Demand Google never shows you"
        source="Bing Webmaster"
        intro="A second search engine's view of demand — catching intent that Google's data hides from you."
      />
      <BingOnlyQueriesSection data={data.bingOnlyQueries} />
    </div>
  );
}
