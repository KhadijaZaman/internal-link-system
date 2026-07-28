// Original data research: turns the site's own stored data into
// citation-ready statistics nobody else has published. Every analysis is
// deterministic and cost-safe — the only external read is the normal cached
// GSC pull; no AI calls, no paid fetches.
import {
  db,
  pagesTable,
  wpPostsTable,
  aiCitationRowsTable,
  aiCitationUploadsTable,
  researchRunsTable,
  researchFindingsTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { queryGsc } from "../integrations/gsc";
import { isOperatorQuery } from "./clustering";
import { canonicalPath } from "../lib/urlCanon";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

export interface DetailRow {
  label: string;
  value: number;
  extra: string | null;
}

export interface FindingInput {
  slug: string;
  title: string;
  headlineStat: string;
  headlineValue: number | null;
  citation: string;
  methodology: string;
  detail: DetailRow[];
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
const fmtInt = (n: number): string => n.toLocaleString("en-US");

interface QueryRow {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Aggregate the raw GSC rows per query (impression-weighted position). */
function aggregateQueries(
  rows: Array<{ query: string; clicks: number; impressions: number; position: number }>,
): QueryRow[] {
  const map = new Map<string, { c: number; i: number; pw: number; w: number }>();
  for (const r of rows) {
    const q = r.query.trim().toLowerCase();
    if (!q) continue;
    let a = map.get(q);
    if (!a) {
      a = { c: 0, i: 0, pw: 0, w: 0 };
      map.set(q, a);
    }
    a.c += r.clicks;
    a.i += r.impressions;
    a.pw += r.position * Math.max(r.impressions, 1);
    a.w += Math.max(r.impressions, 1);
  }
  return [...map.entries()].map(([query, a]) => ({
    query,
    clicks: a.c,
    impressions: a.i,
    position: a.pw / Math.max(a.w, 1),
  }));
}

// --- analyses ---------------------------------------------------------------

function ctrCurve(host: string, window: string, qs: QueryRow[]): FindingInput | null {
  const buckets: Array<{ label: string; min: number; max: number }> = [
    { label: "Positions 1–3", min: 0, max: 3 },
    { label: "Positions 4–10", min: 3, max: 10 },
    { label: "Positions 11–20", min: 10, max: 20 },
  ];
  const detail: DetailRow[] = [];
  const stats: number[] = [];
  for (const b of buckets) {
    const rows = qs.filter((q) => q.position > b.min && q.position <= b.max);
    const imp = rows.reduce((s, r) => s + r.impressions, 0);
    const clk = rows.reduce((s, r) => s + r.clicks, 0);
    if (imp < 100) return null;
    const ctr = pct(clk, imp);
    stats.push(ctr);
    detail.push({ label: b.label, value: ctr, extra: `${fmtInt(imp)} impressions, ${fmtInt(clk)} clicks` });
  }
  const [top, mid] = stats as [number, number, number];
  const multiple = mid > 0 ? Math.round((top / mid) * 10) / 10 : 0;
  const totalQ = qs.length;
  return {
    slug: "ctr_curve",
    title: "Click-through rate by ranking position",
    headlineStat: `${multiple}×`,
    headlineValue: multiple,
    citation: `Across ${fmtInt(totalQ)} search queries on ${host} (${window}), results ranking in positions 1–3 earned a ${top}% click-through rate — ${multiple}× the ${mid}% CTR of positions 4–10.`,
    methodology: `Google Search Console query-level data for ${host}, ${window}, finalized data only. Queries bucketed by impression-weighted average position; CTR = clicks ÷ impressions per bucket. Buckets with under 100 impressions are excluded.`,
    detail,
  };
}

function aiAgentQueries(host: string, window: string, qs: QueryRow[]): FindingInput | null {
  if (qs.length < 200) return null;
  const totalImp = qs.reduce((s, q) => s + q.impressions, 0);
  const ops = qs.filter((q) => isOperatorQuery(q.query));
  if (ops.length === 0) return null;
  const opImp = ops.reduce((s, q) => s + q.impressions, 0);
  const shareQ = pct(ops.length, qs.length);
  const top = [...ops].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  return {
    slug: "ai_agent_queries",
    title: "AI-agent search queries hitting the site",
    headlineStat: `${shareQ}%`,
    headlineValue: shareQ,
    citation: `${shareQ}% of the ${fmtInt(qs.length)} unique search queries that surfaced ${host} (${window}) were machine-generated operator/boolean searches — the fingerprint of AI agents researching on users' behalf — accounting for ${fmtInt(opImp)} impressions (${pct(opImp, totalImp)}% of all impressions).`,
    methodology: `Google Search Console query-level data for ${host}, ${window}. Queries classified as AI-agent searches when they contain quoted phrases, Google search operators (site:, intitle:, …), or boolean group structures — patterns human searchers essentially never type.`,
    detail: top.map((q) => ({ label: q.query, value: q.impressions, extra: "impressions" })),
  };
}

function zeroClickTop5(host: string, window: string, qs: QueryRow[]): FindingInput | null {
  const top5 = qs.filter((q) => q.position <= 5 && q.impressions >= 20 && !isOperatorQuery(q.query));
  if (top5.length < 30) return null;
  const zero = top5.filter((q) => q.clicks === 0);
  const share = pct(zero.length, top5.length);
  const zeroImp = zero.reduce((s, q) => s + q.impressions, 0);
  const top = [...zero].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  return {
    slug: "zero_click_top5",
    title: "Top-5 rankings that get zero clicks",
    headlineStat: `${share}%`,
    headlineValue: share,
    citation: `${share}% of the ${fmtInt(top5.length)} queries where ${host} ranked in the top 5 (${window}) produced zero clicks despite ${fmtInt(zeroImp)} combined impressions — visibility that search features and AI answers absorb before a click happens.`,
    methodology: `Google Search Console query-level data for ${host}, ${window}. Queries with impression-weighted average position ≤ 5 and at least 20 impressions; operator/AI-agent queries excluded. "Zero-click" = 0 recorded clicks in the window.`,
    detail: top.map((q) => ({
      label: q.query,
      value: q.impressions,
      extra: `position ${Math.round(q.position * 10) / 10}`,
    })),
  };
}

function pageTwoUpside(host: string, window: string, qs: QueryRow[]): FindingInput | null {
  const p2 = qs.filter(
    (q) => q.position > 10 && q.position <= 20 && q.impressions >= 10 && !isOperatorQuery(q.query),
  );
  if (p2.length < 20) return null;
  const imp = p2.reduce((s, q) => s + q.impressions, 0);
  const clk = p2.reduce((s, q) => s + q.clicks, 0);
  const ctr = pct(clk, imp);
  const top = [...p2].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  return {
    slug: "page_two_upside",
    title: "Demand parked on page 2",
    headlineStat: fmtInt(imp),
    headlineValue: imp,
    citation: `${fmtInt(p2.length)} queries held page-2 positions for ${host} (${window}), generating ${fmtInt(imp)} impressions but only a ${ctr}% click-through rate — demand already earned that converts almost entirely on a page-1 move.`,
    methodology: `Google Search Console query-level data for ${host}, ${window}. Queries with impression-weighted average position 11–20 and at least 10 impressions; operator/AI-agent queries excluded.`,
    detail: top.map((q) => ({
      label: q.query,
      value: q.impressions,
      extra: `position ${Math.round(q.position * 10) / 10}`,
    })),
  };
}

async function contentAge(site: SiteContext): Promise<FindingInput | null> {
  const posts = await db
    .select({ url: wpPostsTable.url, publishDate: wpPostsTable.publishDate })
    .from(wpPostsTable)
    .where(eq(wpPostsTable.siteId, site.id));
  const pages = await db
    .select({ path: pagesTable.path, clicks: pagesTable.clicks })
    .from(pagesTable)
    .where(eq(pagesTable.siteId, site.id));
  if (posts.length < 20) return null;
  const clicksByPath = new Map(pages.map((p) => [p.path, p.clicks ?? 0]));
  const now = Date.now();
  let dated = 0;
  let oldClicks = 0;
  let totalClicks = 0;
  let oldCount = 0;
  const buckets = [
    { label: "Under 6 months old", max: 183, clicks: 0, n: 0 },
    { label: "6–12 months old", max: 366, clicks: 0, n: 0 },
    { label: "Over 12 months old", max: Infinity, clicks: 0, n: 0 },
  ];
  for (const post of posts) {
    if (!post.publishDate) continue;
    const ageDays = (now - new Date(post.publishDate).getTime()) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0) continue;
    dated++;
    const clicks = clicksByPath.get(canonicalPath(post.url, site.host) ?? "") ?? 0;
    totalClicks += clicks;
    const bucket = buckets.find((b) => ageDays <= b.max)!;
    bucket.clicks += clicks;
    bucket.n++;
    if (ageDays > 366) {
      oldClicks += clicks;
      oldCount++;
    }
  }
  if (dated < 20 || totalClicks < 100) return null;
  const share = pct(oldClicks, totalClicks);
  return {
    slug: "content_age",
    title: "How much traffic old content still carries",
    headlineStat: `${share}%`,
    headlineValue: share,
    citation: `${share}% of ${site.host}'s organic clicks land on content published more than a year ago (${fmtInt(oldCount)} of ${fmtInt(dated)} dated pages) — evidence that compounding content keeps paying long after publication.`,
    methodology: `Publish dates from the site's own CMS crawl joined to Google Search Console click totals per page (latest sync). Pages without a parseable publish date excluded (${fmtInt(dated)} of ${fmtInt(posts.length)} pages dated).`,
    detail: buckets.map((b) => ({
      label: b.label,
      value: b.clicks,
      extra: `${fmtInt(b.n)} pages`,
    })),
  };
}

async function aiCitations(site: SiteContext): Promise<FindingInput | null> {
  const [upload] = await db
    .select({ id: aiCitationUploadsTable.id })
    .from(aiCitationUploadsTable)
    .where(eq(aiCitationUploadsTable.siteId, site.id))
    .orderBy(desc(aiCitationUploadsTable.uploadedAt))
    .limit(1);
  if (!upload) return null;
  const rows = await db
    .select({ path: aiCitationRowsTable.path, citations: aiCitationRowsTable.citations })
    .from(aiCitationRowsTable)
    .where(and(eq(aiCitationRowsTable.siteId, site.id), eq(aiCitationRowsTable.uploadId, upload.id)));
  const cited = rows.filter((r) => r.path != null && r.citations > 0);
  if (cited.length < 5) return null;
  const total = cited.reduce((s, r) => s + r.citations, 0);
  const byPath = new Map<string, number>();
  for (const r of cited) byPath.set(r.path!, (byPath.get(r.path!) ?? 0) + r.citations);
  const sorted = [...byPath.entries()].sort((a, b) => b[1] - a[1]);
  const top10 = sorted.slice(0, 10);
  const top10Sum = top10.reduce((s, [, c]) => s + c, 0);
  const share = pct(top10Sum, total);
  return {
    slug: "ai_citation_concentration",
    title: "AI citations concentrate on a few pages",
    headlineStat: `${share}%`,
    headlineValue: share,
    citation: `${share}% of the ${fmtInt(total)} AI-assistant citations of ${site.host} point at just ${Math.min(10, sorted.length)} pages (of ${fmtInt(sorted.length)} cited) — AI answers reward a small set of authoritative pages, not the whole site.`,
    methodology: `Latest AI-citation export uploaded for ${site.host}; citation counts summed per canonical page path. Concentration = share of total citations held by the top 10 pages.`,
    detail: top10.slice(0, 5).map(([path, c]) => ({ label: path, value: c, extra: "citations" })),
  };
}

// --- runner -----------------------------------------------------------------

export async function runDataResearch(site: SiteContext) {
  const windowStart = isoDaysAgo(93);
  const windowEnd = isoDaysAgo(3);
  const windowLabel = `${windowStart} to ${windowEnd}`;

  const [run] = await db
    .insert(researchRunsTable)
    .values({ siteId: site.id, status: "running", windowStart, windowEnd })
    .returning();
  if (!run) throw new Error("failed to create research run");

  try {
    const raw = await queryGsc({
      siteId: site.id,
      startDate: windowStart,
      endDate: windowEnd,
      dimensions: ["query"],
      rowLimit: 5000,
    });
    const qs = aggregateQueries(
      raw.map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position })),
    );

    const findings: FindingInput[] = [];
    const push = (f: FindingInput | null) => {
      if (f) findings.push(f);
    };
    push(ctrCurve(site.host, windowLabel, qs));
    push(aiAgentQueries(site.host, windowLabel, qs));
    push(zeroClickTop5(site.host, windowLabel, qs));
    push(pageTwoUpside(site.host, windowLabel, qs));
    push(await contentAge(site).catch(() => null));
    push(await aiCitations(site).catch(() => null));

    if (findings.length > 0) {
      await db.insert(researchFindingsTable).values(
        findings.map((f) => ({
          siteId: site.id,
          runId: run.id,
          slug: f.slug,
          title: f.title,
          headlineStat: f.headlineStat,
          headlineValue: f.headlineValue,
          citation: f.citation,
          methodology: f.methodology,
          detail: f.detail,
        })),
      );
    }
    await db
      .update(researchRunsTable)
      .set({ status: "complete", finishedAt: new Date() })
      .where(eq(researchRunsTable.id, run.id));
    logger.info({ siteId: site.id, runId: run.id, findings: findings.length }, "Data research complete");
    return run.id;
  } catch (e) {
    await db
      .update(researchRunsTable)
      .set({ status: "error", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() })
      .where(eq(researchRunsTable.id, run.id));
    throw e;
  }
}
