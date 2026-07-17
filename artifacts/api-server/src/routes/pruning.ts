import { Router, type IRouter } from "express";
import { sql, inArray } from "drizzle-orm";
import { db, gscSnapshotsTable, wpPostsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { cosineSim } from "../lib/semanticScorer";
import { ensureQueryIntel } from "../services/queryIntel";

const router: IRouter = Router();

/**
 * Cosine-similarity cutoff between a GSC query embedding and a page embedding
 * for the query to count as "on-intent" for that page.
 *
 * 0.35 chosen empirically against text-embedding-3-small: branded competitor
 * queries (e.g. "contentshake" against an "AI content optimization tools"
 * page) score 0.10 - 0.25; legitimate variations of the page's actual topic
 * (e.g. "best ai content tools 2026") score 0.45 - 0.75.
 */
const ON_INTENT_THRESHOLD = 0.35;

interface QueryAggRow {
  url: string;
  query: string;
  best_position: number;
  impressions: number;
  clicks: number;
}

type IntentVerdict = "on_intent_no_clicks" | "off_intent_only" | "mixed" | "unknown";

router.get("/pruning-suggestions", requireAuth, async (_req, res) => {
  const rangeRows = await db
    .select({
      minDate: sql<string | null>`MIN(snapshot_date)`,
      maxDate: sql<string | null>`MAX(snapshot_date)`,
    })
    .from(gscSnapshotsTable);
  const fullMin = rangeRows[0]?.minDate ?? null;
  const fullMax = rangeRows[0]?.maxDate ?? null;

  if (!fullMin || !fullMax) {
    res.json({
      runAt: new Date().toISOString(),
      windowStart: null,
      windowEnd: null,
      totalDays: 0,
      itemCount: 0,
      items: [],
    });
    return;
  }

  const fullMinDate = new Date(fullMin + "T00:00:00Z");
  const cutoffCandidate = new Date(fullMax + "T00:00:00Z");
  cutoffCandidate.setUTCDate(cutoffCandidate.getUTCDate() - 180);
  const effectiveStart = (
    cutoffCandidate > fullMinDate ? cutoffCandidate : fullMinDate
  )
    .toISOString()
    .slice(0, 10);
  const effectiveEnd = fullMax;

  const daysRows = await db
    .select({
      totalDays: sql<number>`COUNT(DISTINCT snapshot_date)::int`,
    })
    .from(gscSnapshotsTable)
    .where(
      sql`snapshot_date BETWEEN ${effectiveStart}::date AND ${effectiveEnd}::date`,
    );
  const totalDays = Number(daysRows[0]?.totalDays ?? 0);

  // Stage 1 — coarse candidate selection: any URL that reached top-3 for at
  // least one query AND has zero clicks across all queries in the window.
  // These are the *pre-intent-filter* pruning candidates; stage 2 below
  // narrows the list to pages whose ON-INTENT queries earn zero clicks.
  // Exclude advanced-operator queries (`site:`, `inurl:`, `intitle:`, etc).
  // They're crawler probes, not natural search demand — they skew the
  // pruning candidate list with zero-click "rankings" that nobody would
  // ever click on anyway.
  const candRows = (await db.execute(sql`
    WITH win AS (
      SELECT url, query, snapshot_date, position, impressions, clicks
      FROM ${gscSnapshotsTable}
      WHERE snapshot_date BETWEEN ${effectiveStart}::date AND ${effectiveEnd}::date
        AND query NOT ILIKE '%site:%'
        AND query NOT ILIKE '%inurl:%'
        AND query NOT ILIKE '%intitle:%'
    )
    SELECT url,
           MIN(position)::float AS best_position,
           COALESCE(SUM(impressions), 0)::int AS total_impressions,
           COALESCE(SUM(clicks), 0)::int AS total_clicks,
           COUNT(DISTINCT snapshot_date)::int AS days_observed
    FROM win
    GROUP BY url
    HAVING MIN(position) <= 3
       AND COALESCE(SUM(clicks), 0) = 0
       AND COUNT(DISTINCT CASE WHEN position <= 3 THEN query END) >= 1
    ORDER BY url ASC
    LIMIT 500
  `)) as unknown as {
    rows: Array<{
      url: string;
      best_position: number;
      total_impressions: number;
      total_clicks: number;
      days_observed: number;
    }>;
  };

  const candidates =
    candRows.rows ??
    (candRows as unknown as Array<{
      url: string;
      best_position: number;
      total_impressions: number;
      total_clicks: number;
      days_observed: number;
    }>);

  if (candidates.length === 0) {
    res.json({
      runAt: new Date().toISOString(),
      windowStart: effectiveStart,
      windowEnd: effectiveEnd,
      totalDays,
      itemCount: 0,
      items: [],
    });
    return;
  }

  const urls = candidates.map((c) => c.url);

  // Per-(url, query) aggregate for every top-3 query on every candidate URL.
  // Note: we embed an `inArray(...)` fragment instead of `ANY(${urls})` —
  // drizzle's sql template would otherwise expand the JS array into a
  // tuple of placeholders, which Postgres rejects when used with ANY.
  const urlFilter = inArray(gscSnapshotsTable.url, urls);
  const perQueryRows = (await db.execute(sql`
    WITH win AS (
      SELECT url, query, position, impressions, clicks
      FROM ${gscSnapshotsTable}
      WHERE snapshot_date BETWEEN ${effectiveStart}::date AND ${effectiveEnd}::date
        AND ${urlFilter}
        AND query NOT ILIKE '%site:%'
        AND query NOT ILIKE '%inurl:%'
        AND query NOT ILIKE '%intitle:%'
    )
    SELECT url,
           query,
           MIN(position)::float AS best_position,
           COALESCE(SUM(impressions), 0)::int AS impressions,
           COALESCE(SUM(clicks), 0)::int AS clicks
    FROM win
    WHERE position <= 3
    GROUP BY url, query
    ORDER BY url ASC, MIN(position) ASC
  `)) as unknown as { rows: QueryAggRow[] };

  const perQuery: QueryAggRow[] =
    perQueryRows.rows ?? (perQueryRows as unknown as QueryAggRow[]);

  // Load page embeddings + titles for the candidates.
  const posts = await db
    .select({
      url: wpPostsTable.url,
      title: wpPostsTable.title,
      embedding: wpPostsTable.embedding,
    })
    .from(wpPostsTable)
    .where(inArray(wpPostsTable.url, urls));
  const postByUrl = new Map(posts.map((p) => [p.url, p]));

  // Warm the query_intel cache (embeddings + DataForSEO volumes).
  const distinctQueries = Array.from(new Set(perQuery.map((r) => r.query)));
  const intelByQuery = await ensureQueryIntel(distinctQueries);

  // Build per-URL detail objects.
  const queriesByUrl = new Map<string, QueryAggRow[]>();
  for (const r of perQuery) {
    const list = queriesByUrl.get(r.url) ?? [];
    list.push(r);
    queriesByUrl.set(r.url, list);
  }

  interface PruningItem {
    url: string;
    title: string | null;
    bestPosition: number;
    queriesInTop3: number;
    totalImpressions: number;
    totalClicks: number;
    daysObserved: number;
    topQueries: string[];
    onIntentQueries: number;
    offIntentQueries: number;
    onIntentVolume: number | null;
    intentVerdict: IntentVerdict;
    queryDetails: Array<{
      query: string;
      bestPosition: number | null;
      impressions: number;
      clicks: number;
      similarity: number | null;
      intent: "on" | "off" | "unknown";
      searchVolume: number | null;
    }>;
  }

  const items: PruningItem[] = [];
  for (const cand of candidates) {
    const post = postByUrl.get(cand.url);
    const pageEmb = post?.embedding ?? null;
    const qs = queriesByUrl.get(cand.url) ?? [];

    let onIntent = 0;
    let offIntent = 0;
    let onIntentVolumeKnown = false;
    let onIntentVolumeSum = 0;
    const queryDetails: PruningItem["queryDetails"] = [];

    for (const q of qs) {
      const intel = intelByQuery.get(q.query.trim().toLowerCase());
      const queryEmb = intel?.embedding ?? null;
      let intent: "on" | "off" | "unknown" = "unknown";
      let similarity: number | null = null;
      if (queryEmb && pageEmb) {
        similarity = cosineSim(queryEmb, pageEmb);
        intent = similarity >= ON_INTENT_THRESHOLD ? "on" : "off";
      }
      if (intent === "on") onIntent++;
      else if (intent === "off") offIntent++;
      const volume = intel?.searchVolume ?? null;
      if (intent === "on" && volume !== null) {
        onIntentVolumeKnown = true;
        onIntentVolumeSum += volume;
      }
      queryDetails.push({
        query: q.query,
        bestPosition: Number.isFinite(q.best_position) ? q.best_position : null,
        impressions: Number(q.impressions),
        clicks: Number(q.clicks),
        similarity,
        intent,
        searchVolume: volume,
      });
    }

    const unknownIntent = qs.length - onIntent - offIntent;
    let verdict: IntentVerdict;
    if (qs.length === 0) {
      verdict = "unknown";
    } else if (unknownIntent > 0 && onIntent === 0 && offIntent === 0) {
      // Nothing classified yet — embedding backfill still pending.
      verdict = "unknown";
    } else if (unknownIntent > 0) {
      // Partial classification: be honest, call it mixed so the operator
      // doesn't act on a half-classified verdict.
      verdict = "mixed";
    } else if (onIntent > 0 && offIntent === 0) {
      verdict = "on_intent_no_clicks";
    } else if (onIntent === 0 && offIntent > 0) {
      verdict = "off_intent_only";
    } else {
      verdict = "mixed";
    }

    // Sort detail rows: on-intent first (most volume/impressions), then
    // off-intent, then unknown — so the operator immediately sees what
    // matters.
    queryDetails.sort((a, b) => {
      const rank = (i: "on" | "off" | "unknown") =>
        i === "on" ? 0 : i === "off" ? 1 : 2;
      if (rank(a.intent) !== rank(b.intent)) return rank(a.intent) - rank(b.intent);
      return b.impressions - a.impressions;
    });

    items.push({
      url: cand.url,
      title: post?.title ?? null,
      bestPosition: Number(cand.best_position),
      queriesInTop3: qs.length,
      totalImpressions: Number(cand.total_impressions),
      totalClicks: Number(cand.total_clicks),
      daysObserved: Number(cand.days_observed),
      topQueries: queryDetails.slice(0, 5).map((d) => d.query),
      onIntentQueries: onIntent,
      offIntentQueries: offIntent,
      onIntentVolume: onIntentVolumeKnown ? onIntentVolumeSum : null,
      intentVerdict: verdict,
      queryDetails,
    });
  }

  // Stage 2 filter: drop pages where every top-3 query is off-intent. Those
  // pages aren't a pruning concern — the page just incidentally ranks for
  // irrelevant queries it'll never get clicks from.
  const filtered = items.filter((it) => it.intentVerdict !== "off_intent_only");

  // Sort: on_intent_no_clicks first (the real pruning candidates), then
  // mixed, then unknown (no embedding yet).
  const verdictRank: Record<IntentVerdict, number> = {
    on_intent_no_clicks: 0,
    mixed: 1,
    unknown: 2,
    off_intent_only: 3,
  };
  filtered.sort((a, b) => {
    const dv = verdictRank[a.intentVerdict] - verdictRank[b.intentVerdict];
    if (dv !== 0) return dv;
    if (a.onIntentQueries !== b.onIntentQueries)
      return b.onIntentQueries - a.onIntentQueries;
    return a.totalImpressions - b.totalImpressions;
  });

  res.json({
    runAt: new Date().toISOString(),
    windowStart: effectiveStart,
    windowEnd: effectiveEnd,
    totalDays,
    itemCount: filtered.length,
    items: filtered,
  });
});

export default router;
