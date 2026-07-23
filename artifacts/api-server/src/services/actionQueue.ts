import {
  db,
  actionItemsTable,
  gscSnapshotsTable,
  inventoryTable,
  linkExcludeListTable,
  linkStatsTable,
  linkSuggestionsTable,
  optimizeQueueTable,
  queryLosersTable,
  wpPostsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";
import type { SiteContext } from "../lib/site";
import { persistHealthSnapshot } from "./health";
import {
  EXPECTED_CTR,
  CTR_UNDERPERFORM_RATIO,
  CTR_MIN_IMPRESSIONS,
  CTR_MIN_MISSED_CLICKS,
  scoreOf,
  pickCannibalContenders,
} from "../lib/insights";

/**
 * Unified action queue recompute.
 *
 * Turns today's live signals into one ranked "do this next" list:
 *   - add_inbound_links   — orphan pages (link_stats.is_orphan, real pages only)
 *   - add_outbound_links  — dead-end pages (link_stats.is_dead_end)
 *   - fix_losing_query    — critical/high query losers from the latest week
 *   - review_suggestions  — pending link suggestions grouped per receiver page
 *   - optimize_content    — pages sitting in the optimize queue
 *   - improve_ctr         — top-10 rankings whose CTR is far below the
 *                           position norm (title/meta rewrite = free clicks)
 *   - fix_cannibalization — two+ pages splitting impressions on one query
 *
 * Score = type weight x (1 + log10(1 + impressions at stake)) so pages with
 * real search demand rank first but one huge page can't drown out the rest.
 *
 * Reconciliation contract (why this is a table and not a view):
 *   - upsert by dedupe_key (action_type + normalized URL) — stable IDs
 *   - open items whose source signal disappeared are auto-closed
 *     (status=done, resolution=auto) — that timestamp is the impact-tracking
 *     "work happened here" event
 *   - dismissed/done rows are never resurrected
 */

export type ActionType =
  | "add_inbound_links"
  | "add_outbound_links"
  | "fix_losing_query"
  | "review_suggestions"
  | "optimize_content"
  | "improve_ctr"
  | "fix_cannibalization";

const TYPE_WEIGHTS: Record<ActionType, number> = {
  fix_losing_query: 100, // critical gets 100; high 70 (handled below)
  fix_cannibalization: 75, // consolidating split rankings compounds fast
  improve_ctr: 65, // title/meta rewrite — cheapest click win available
  add_inbound_links: 60,
  optimize_content: 55,
  review_suggestions: 50,
  add_outbound_links: 30,
};

/**
 * Brand token from SITE_DOMAIN — brand queries follow navigational CTR norms
 * (sitelinks, brand SERPs), so organic benchmarks don't apply to them.
 */
const BRAND_TOKEN = (() => {
  const d = (process.env["SITE_DOMAIN"] ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  const token = d.split(".")[0] ?? "";
  return token.length >= 4 ? token : null;
})();

/** Same exclude-list semantics as the crawl/linking jobs (local copy — see audits.ts). */
function compileExcludePattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(escaped);
}

function isExcludedUrl(url: string, regexes: RegExp[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return regexes.some((re) => re.test(path) || re.test(url));
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/** One canonical URL key: drop scheme, leading www., query, fragment, trailing slash. */
export function urlKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\/+$/, "");
  return s;
}

interface DesiredAction {
  dedupeKey: string;
  actionType: ActionType;
  targetUrl: string;
  title: string | null;
  description: string;
  score: number;
  impressionsAtStake: number;
  clicksAtStake: number;
  source: Record<string, unknown>;
}

async function loadTitleMap(urls: string[], siteId: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(urls));
  if (unique.length === 0) return map;
  const [posts, inv] = await Promise.all([
    db
      .select({ url: wpPostsTable.url, title: wpPostsTable.title, h1: wpPostsTable.h1 })
      .from(wpPostsTable)
      .where(and(inArray(wpPostsTable.url, unique), eq(wpPostsTable.siteId, siteId))),
    db
      .select({ url: inventoryTable.url, title: inventoryTable.title })
      .from(inventoryTable)
      .where(and(inArray(inventoryTable.url, unique), eq(inventoryTable.siteId, siteId))),
  ]);
  for (const p of posts) {
    const t = p.title ?? p.h1;
    if (t) map.set(urlKey(p.url), t);
  }
  for (const r of inv) {
    const k = urlKey(r.url);
    if (!map.has(k) && r.title) map.set(k, r.title);
  }
  return map;
}

/** inventory metrics keyed by normalized URL (inventory.url is the GSC page URL). */
async function loadInventoryByKey(siteId: number): Promise<
  Map<string, { impressions: number; clicks: number; topQuery: string | null }>
> {
  const rows = await db
    .select({
      url: inventoryTable.url,
      impressions: inventoryTable.impressions,
      clicks: inventoryTable.clicks,
      topQuery: inventoryTable.topQuery,
    })
    .from(inventoryTable)
    .where(eq(inventoryTable.siteId, siteId));
  const map = new Map<string, { impressions: number; clicks: number; topQuery: string | null }>();
  for (const r of rows) {
    const k = urlKey(r.url);
    const prev = map.get(k);
    // GSC can report anchor-fragment variants as separate pages — SUM by key.
    map.set(k, {
      impressions: (prev?.impressions ?? 0) + (r.impressions ?? 0),
      clicks: (prev?.clicks ?? 0) + (r.clicks ?? 0),
      topQuery: prev?.topQuery ?? r.topQuery,
    });
  }
  return map;
}

async function collectDesiredActions(siteId: number): Promise<DesiredAction[]> {
  const invByKey = await loadInventoryByKey(siteId);
  const metricsFor = (url: string) =>
    invByKey.get(urlKey(url)) ?? { impressions: 0, clicks: 0, topQuery: null };

  const desired: DesiredAction[] = [];

  // 1) Orphans & dead-ends (already ghost-filtered to real pages upstream)
  const stats = await db
    .select({
      url: linkStatsTable.url,
      isOrphan: linkStatsTable.isOrphan,
      isDeadEnd: linkStatsTable.isDeadEnd,
      inbound: linkStatsTable.inboundCount,
      outbound: linkStatsTable.outboundCount,
    })
    .from(linkStatsTable)
    .where(eq(linkStatsTable.siteId, siteId));
  for (const s of stats) {
    const m = metricsFor(s.url);
    if (s.isOrphan) {
      desired.push({
        dedupeKey: `add_inbound_links:${urlKey(s.url)}`,
        actionType: "add_inbound_links",
        targetUrl: s.url,
        title: null,
        description:
          m.impressions > 0
            ? `Orphan page — no internal links point here despite ${m.impressions.toLocaleString()} search impressions. Add links from related pages.`
            : "Orphan page — no internal links point here. Add links from related pages so search engines and visitors can find it.",
        score: scoreOf(TYPE_WEIGHTS.add_inbound_links, m.impressions),
        impressionsAtStake: m.impressions,
        clicksAtStake: m.clicks,
        source: { kind: "orphan", topQuery: m.topQuery },
      });
    }
    if (s.isDeadEnd) {
      desired.push({
        dedupeKey: `add_outbound_links:${urlKey(s.url)}`,
        actionType: "add_outbound_links",
        targetUrl: s.url,
        title: null,
        description:
          "Dead-end page — it links out to nothing, so visitors and link equity stop here. Add outbound links to related pages.",
        score: scoreOf(TYPE_WEIGHTS.add_outbound_links, m.impressions),
        impressionsAtStake: m.impressions,
        clicksAtStake: m.clicks,
        source: { kind: "dead_end", topQuery: m.topQuery },
      });
    }
  }

  // 2) Query losers — latest week, critical/high only, grouped per URL
  const latestWeek = await db
    .select({ weekOf: queryLosersTable.weekOf })
    .from(queryLosersTable)
    .where(eq(queryLosersTable.siteId, siteId))
    .orderBy(desc(queryLosersTable.weekOf))
    .limit(1);
  if (latestWeek.length > 0) {
    const weekOf = latestWeek[0]!.weekOf;
    const losers = await db
      .select()
      .from(queryLosersTable)
      .where(and(eq(queryLosersTable.weekOf, weekOf), eq(queryLosersTable.siteId, siteId)));
    const byUrl = new Map<
      string,
      { url: string; severity: string; queries: { query: string; drop: number }[]; impressions: number }
    >();
    for (const l of losers) {
      if (l.severity !== "critical" && l.severity !== "high") continue;
      const k = urlKey(l.url);
      const entry =
        byUrl.get(k) ?? { url: l.url, severity: "high", queries: [], impressions: 0 };
      if (l.severity === "critical") entry.severity = "critical";
      entry.queries.push({
        query: l.query,
        drop: l.positionChange ?? 0,
      });
      entry.impressions += Math.max(l.prevImpressions ?? 0, l.currImpressions ?? 0);
      byUrl.set(k, entry);
    }
    for (const [k, e] of byUrl) {
      const weight = e.severity === "critical" ? 100 : 70;
      e.queries.sort((a, b) => b.drop - a.drop);
      const top = e.queries[0];
      desired.push({
        dedupeKey: `fix_losing_query:${k}`,
        actionType: "fix_losing_query",
        targetUrl: e.url,
        title: null,
        description:
          e.queries.length === 1
            ? `Ranking dropped for "${top?.query}". Refresh this page's content and internal links before the traffic is gone.`
            : `Rankings dropped for ${e.queries.length} queries (worst: "${top?.query}"). Refresh this page's content and internal links.`,
        score: scoreOf(weight, e.impressions),
        impressionsAtStake: e.impressions,
        clicksAtStake: 0,
        source: {
          kind: "query_loser",
          severity: e.severity,
          weekOf,
          queries: e.queries.slice(0, 5),
        },
      });
    }
  }

  // 3) Pending link suggestions — grouped per receiver page
  const pending = await db
    .select({
      receiverUrl: linkSuggestionsTable.receiverUrl,
      priorityScore: linkSuggestionsTable.priorityScore,
    })
    .from(linkSuggestionsTable)
    .where(
      and(
        eq(linkSuggestionsTable.status, "pending_review"),
        eq(linkSuggestionsTable.siteId, siteId),
      ),
    );
  const byReceiver = new Map<string, { url: string; count: number; best: number }>();
  for (const p of pending) {
    const k = urlKey(p.receiverUrl);
    const entry = byReceiver.get(k) ?? { url: p.receiverUrl, count: 0, best: 0 };
    entry.count += 1;
    entry.best = Math.max(entry.best, p.priorityScore ?? 0);
    byReceiver.set(k, entry);
  }
  for (const [k, e] of byReceiver) {
    const m = metricsFor(e.url);
    desired.push({
      dedupeKey: `review_suggestions:${k}`,
      actionType: "review_suggestions",
      targetUrl: e.url,
      title: null,
      description:
        e.count === 1
          ? "1 ready-to-apply internal link suggestion is waiting for review for this page."
          : `${e.count} ready-to-apply internal link suggestions are waiting for review for this page.`,
      score: scoreOf(TYPE_WEIGHTS.review_suggestions, m.impressions),
      impressionsAtStake: m.impressions,
      clicksAtStake: m.clicks,
      source: { kind: "pending_suggestions", count: e.count, bestPriority: e.best },
    });
  }

  // 4) Optimize queue — pages queued but not completed
  const queued = await db
    .select({
      url: optimizeQueueTable.url,
      priority: optimizeQueueTable.priority,
      briefMarkdown: optimizeQueueTable.briefMarkdown,
    })
    .from(optimizeQueueTable)
    .where(
      and(
        eq(optimizeQueueTable.status, "optimize"),
        eq(optimizeQueueTable.siteId, siteId),
      ),
    );
  for (const q of queued) {
    const m = metricsFor(q.url);
    const hasBrief = Boolean(q.briefMarkdown && q.briefMarkdown.trim().length > 0);
    desired.push({
      dedupeKey: `optimize_content:${urlKey(q.url)}`,
      actionType: "optimize_content",
      targetUrl: q.url,
      title: null,
      description: hasBrief
        ? "An optimization brief is ready for this page — apply it and mark the item done."
        : "This page is queued for optimization. Generate a brief from the Optimizer page, then apply it.",
      score: scoreOf(
        TYPE_WEIGHTS.optimize_content + (q.priority === "high" ? 15 : q.priority === "low" ? -15 : 0),
        m.impressions,
      ),
      impressionsAtStake: m.impressions,
      clicksAtStake: m.clicks,
      source: { kind: "optimize_queue", priority: q.priority, hasBrief },
    });
  }

  // 5 + 6) GSC opportunity mining from the latest snapshot (pure SQL, no API
  // calls): CTR under-performers and keyword cannibalization.
  const latestSnap = await db
    .select({ d: sql<string | null>`max(${gscSnapshotsTable.snapshotDate})::text` })
    .from(gscSnapshotsTable)
    .where(eq(gscSnapshotsTable.siteId, siteId));
  const snapDate = latestSnap[0]?.d ?? null;
  if (snapDate) {
    const excludes = await db
      .select()
      .from(linkExcludeListTable)
      .where(eq(linkExcludeListTable.siteId, siteId));
    const excludeRegexes = excludes.map((e) => compileExcludePattern(e.pattern));
    // max() per url+query guards against double rows if the GSC job ran twice
    // on one snapshot date.
    const snapRows = await db
      .select({
        url: gscSnapshotsTable.url,
        query: gscSnapshotsTable.query,
        position: sql<number>`avg(${gscSnapshotsTable.position})`,
        impressions: sql<number>`max(${gscSnapshotsTable.impressions})::int`,
        clicks: sql<number>`max(${gscSnapshotsTable.clicks})::int`,
      })
      .from(gscSnapshotsTable)
      .where(
        and(
          eq(gscSnapshotsTable.snapshotDate, snapDate),
          eq(gscSnapshotsTable.siteId, siteId),
        ),
      )
      .groupBy(gscSnapshotsTable.url, gscSnapshotsTable.query);

    // GSC reports /page/#anchor variants as separate pages — SUM by urlKey.
    interface UrlQueryAgg {
      url: string;
      query: string;
      imps: number;
      clicks: number;
      posSum: number;
      posW: number;
    }
    const byUrlQuery = new Map<string, UrlQueryAgg>();
    // Honest cannibalization denominators: total impressions per query over
    // ALL pages, before any floor/exclude filtering shrinks the pool.
    const queryTotalImps = new Map<string, number>();
    for (const r of snapRows) {
      const rawImps = r.impressions ?? 0;
      queryTotalImps.set(r.query, (queryTotalImps.get(r.query) ?? 0) + rawImps);
      if (rawImps < 10) continue; // long-tail noise floor for candidates
      if (isExcludedUrl(r.url, excludeRegexes)) continue;
      if (BRAND_TOKEN && r.query.includes(BRAND_TOKEN)) continue;
      const k = `${urlKey(r.url)}||${r.query}`;
      const e =
        byUrlQuery.get(k) ??
        ({ url: r.url, query: r.query, imps: 0, clicks: 0, posSum: 0, posW: 0 } as UrlQueryAgg);
      const imps = r.impressions ?? 0;
      e.imps += imps;
      e.clicks += r.clicks ?? 0;
      e.posSum += (r.position ?? 0) * Math.max(imps, 1);
      e.posW += Math.max(imps, 1);
      // Keep the shortest URL variant (the fragment-free canonical one).
      if (r.url.length < e.url.length) e.url = r.url;
      byUrlQuery.set(k, e);
    }

    // 5) improve_ctr — ranks top-10 but earns far fewer clicks than the norm.
    interface CtrQuery {
      query: string;
      impressions: number;
      position: number;
      ctr: number;
      expectedCtr: number;
    }
    const ctrOpp = new Map<
      string,
      { url: string; missed: number; imps: number; clicks: number; queries: CtrQuery[] }
    >();
    for (const a of byUrlQuery.values()) {
      const pos = a.posW > 0 ? a.posSum / a.posW : 0;
      const expected = EXPECTED_CTR[Math.round(pos)];
      if (!expected) continue; // outside the top 10
      if (a.imps < CTR_MIN_IMPRESSIONS) continue;
      const ctr = a.clicks / a.imps;
      if (ctr >= expected * CTR_UNDERPERFORM_RATIO) continue;
      const k = urlKey(a.url);
      const e = ctrOpp.get(k) ?? { url: a.url, missed: 0, imps: 0, clicks: 0, queries: [] };
      e.missed += a.imps * (expected - ctr);
      e.imps += a.imps;
      e.clicks += a.clicks;
      e.queries.push({
        query: a.query,
        impressions: a.imps,
        position: Math.round(pos * 10) / 10,
        ctr: Math.round(ctr * 1000) / 1000,
        expectedCtr: expected,
      });
      ctrOpp.set(k, e);
    }
    for (const [k, e] of ctrOpp) {
      const missed = Math.round(e.missed);
      if (missed < CTR_MIN_MISSED_CLICKS) continue;
      e.queries.sort((a, b) => b.impressions - a.impressions);
      const top = e.queries[0]!;
      desired.push({
        dedupeKey: `improve_ctr:${k}`,
        actionType: "improve_ctr",
        targetUrl: e.url,
        title: null,
        description: `Ranks #${top.position} for "${top.query}" but wins only ${(top.ctr * 100).toFixed(1)}% of clicks vs ~${(top.expectedCtr * 100).toFixed(0)}% typical for that spot. Rewrite the title & meta description — roughly ${missed} clicks/week at stake.`,
        score: scoreOf(TYPE_WEIGHTS.improve_ctr, e.imps),
        impressionsAtStake: e.imps,
        clicksAtStake: e.clicks,
        source: {
          kind: "ctr_opportunity",
          snapshotDate: snapDate,
          missedClicksPerWeek: missed,
          queries: e.queries.slice(0, 3),
        },
      });
    }

    // 6) fix_cannibalization — 2+ pages each holding a real share of one query.
    interface Contender {
      key: string;
      url: string;
      impressions: number;
      clicks: number;
      position: number;
    }
    const byQuery = new Map<string, Contender[]>();
    for (const a of byUrlQuery.values()) {
      const pos = a.posW > 0 ? a.posSum / a.posW : 999;
      const list = byQuery.get(a.query) ?? [];
      list.push({ key: urlKey(a.url), url: a.url, impressions: a.imps, clicks: a.clicks, position: pos });
      byQuery.set(a.query, list);
    }
    interface CannQuery {
      query: string;
      impressions: number;
      competesWith: string;
      position: number;
      strongerPosition: number;
    }
    const cann = new Map<string, { url: string; imps: number; clicks: number; queries: CannQuery[] }>();
    for (const [query, list] of byQuery) {
      const total = queryTotalImps.get(query) ?? list.reduce((s, x) => s + x.impressions, 0);
      // The page actually earning clicks (then better position) is primary;
      // every other contender is diluting it.
      const contenders = pickCannibalContenders(list, total);
      if (contenders.length < 2) continue;
      const primary = contenders[0]!;
      for (const weak of contenders.slice(1)) {
        const e = cann.get(weak.key) ?? { url: weak.url, imps: 0, clicks: 0, queries: [] };
        e.imps += weak.impressions;
        e.clicks += weak.clicks;
        e.queries.push({
          query,
          impressions: weak.impressions,
          competesWith: primary.url,
          position: Math.round(weak.position * 10) / 10,
          strongerPosition: Math.round(primary.position * 10) / 10,
        });
        cann.set(weak.key, e);
      }
    }
    for (const [k, e] of cann) {
      e.queries.sort((a, b) => b.impressions - a.impressions);
      const top = e.queries[0]!;
      const rivalPath = pathOf(top.competesWith);
      desired.push({
        dedupeKey: `fix_cannibalization:${k}`,
        actionType: "fix_cannibalization",
        targetUrl: e.url,
        title: null,
        description:
          e.queries.length === 1
            ? `Splits rankings with ${rivalPath} for "${top.query}" — Google can't pick a winner. Differentiate this page's angle, or consolidate by linking it to the stronger page with that query as the anchor.`
            : `Splits rankings with stronger pages on ${e.queries.length} queries (biggest: "${top.query}" vs ${rivalPath}). Differentiate intent or consolidate with internal links.`,
        score: scoreOf(TYPE_WEIGHTS.fix_cannibalization, e.imps),
        impressionsAtStake: e.imps,
        clicksAtStake: e.clicks,
        source: {
          kind: "cannibalization",
          snapshotDate: snapDate,
          queries: e.queries.slice(0, 5),
        },
      });
    }
  }

  // De-duplicate: if the same key somehow appears twice, keep the higher score.
  const byKey = new Map<string, DesiredAction>();
  for (const d of desired) {
    const prev = byKey.get(d.dedupeKey);
    if (!prev || d.score > prev.score) byKey.set(d.dedupeKey, d);
  }

  // Attach titles in one pass.
  const all = Array.from(byKey.values());
  const titles = await loadTitleMap(all.map((d) => d.targetUrl), siteId);
  for (const d of all) d.title = titles.get(urlKey(d.targetUrl)) ?? null;
  return all;
}

export interface RecomputeResult {
  open: number;
  created: number;
  updated: number;
  autoClosed: number;
}

export async function recomputeActionQueue(siteId: number): Promise<RecomputeResult> {
  const desired = await collectDesiredActions(siteId);
  const desiredByKey = new Map(desired.map((d) => [d.dedupeKey, d]));

  const existing = await db
    .select()
    .from(actionItemsTable)
    .where(eq(actionItemsTable.siteId, siteId));
  const existingByKey = new Map(existing.map((r) => [r.dedupeKey, r]));

  const now = new Date();
  let created = 0;
  let updated = 0;
  let autoClosed = 0;

  for (const row of existing) {
    const want = desiredByKey.get(row.dedupeKey);
    if (want) {
      desiredByKey.delete(row.dedupeKey);
      // Never resurrect dismissed or done rows — the admin (or an earlier
      // auto-close) decided this item's fate; the signal reappearing will be
      // visible again once THIS row ages out, not by flipping it back open.
      if (row.status !== "open") continue;
      await withDbRetry(
        () =>
          db
            .update(actionItemsTable)
            .set({
              title: want.title,
              description: want.description,
              score: want.score,
              impressionsAtStake: want.impressionsAtStake,
              clicksAtStake: want.clicksAtStake,
              source: want.source,
              targetUrl: want.targetUrl,
              lastSeenAt: now,
            })
            .where(and(eq(actionItemsTable.id, row.id), eq(actionItemsTable.siteId, siteId))),
        { label: "action_queue:update" },
      );
      updated++;
    } else if (row.status === "open") {
      // Source signal vanished — the underlying problem was fixed (links
      // added, suggestion inserted, optimization completed...). Auto-close;
      // completed_at becomes the impact-tracking baseline event.
      await withDbRetry(
        () =>
          db
            .update(actionItemsTable)
            .set({ status: "done", resolution: "auto", completedAt: now, lastSeenAt: now })
            .where(and(eq(actionItemsTable.id, row.id), eq(actionItemsTable.siteId, siteId))),
        { label: "action_queue:auto_close" },
      );
      autoClosed++;
    }
  }

  for (const want of desiredByKey.values()) {
    await withDbRetry(
      () =>
        db
          .insert(actionItemsTable)
          .values({
            siteId,
            dedupeKey: want.dedupeKey,
            actionType: want.actionType,
            targetUrl: want.targetUrl,
            title: want.title,
            description: want.description,
            score: want.score,
            impressionsAtStake: want.impressionsAtStake,
            clicksAtStake: want.clicksAtStake,
            source: want.source,
            status: "open",
            lastSeenAt: now,
          })
          .onConflictDoNothing({ target: [actionItemsTable.siteId, actionItemsTable.dedupeKey] }),
      { label: "action_queue:insert" },
    );
    created++;
  }

  const openCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(actionItemsTable)
    .where(and(eq(actionItemsTable.status, "open"), eq(actionItemsTable.siteId, siteId)));

  const result = {
    open: openCount[0]?.n ?? 0,
    created,
    updated,
    autoClosed,
  };
  logger.info(result, "Action queue recomputed");

  // Every recompute refreshes today's health snapshot — the queue runs after
  // each data-producing job, so the score always reflects the latest signals.
  await persistHealthSnapshot(siteId);

  return result;
}

/** Job entrypoint — recomputes the action queue for the given site. */
export async function runRecomputeActionQueue(site: SiteContext): Promise<void> {
  await recomputeActionQueue(site.id);
}

/**
 * Chained recompute for the end of data-producing jobs (crawls, GSC sync,
 * semantic linking). Never throws — a queue refresh failure must not fail
 * the parent job.
 */
export async function chainActionQueueRecompute(after: string, siteId: number): Promise<void> {
  try {
    await recomputeActionQueue(siteId);
  } catch (e) {
    logger.warn({ err: e, after }, "Chained action queue recompute failed");
  }
}
