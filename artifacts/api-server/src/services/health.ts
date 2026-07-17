import { sql, desc, eq } from "drizzle-orm";
import {
  db,
  healthSnapshotsTable,
  linkStatsTable,
  linkSuggestionsTable,
  optimizeQueueTable,
  queryLosersTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";

/**
 * Site health score — one 0-100 number summarizing internal-linking health.
 *
 * Score = 100 - Σ(weight × penalty) over five weighted components, where
 * each penalty is a 0-1 clamp of the underlying problem ratio:
 *
 *   orphans     (30) — orphan share of tracked pages, maxed at 25% share
 *   dead ends   (20) — dead-end share of tracked pages, maxed at 25% share
 *   losers      (25) — critical/high loser pages this week, maxed at 20 pages
 *   backlog     (15) — pending suggestions + queued optimizations, maxed at 150
 *   staleness   (10) — days since the last GSC snapshot, maxed at 14 days
 *
 * The clamp ceilings are operating judgments, not statistics: they mark the
 * point where the operator should treat the component as "on fire" — more
 * of the same problem shouldn't keep dragging an already-failing score.
 *
 * A snapshot row is upserted per day at the end of every action-queue
 * recompute, so the home page can chart the trend over time.
 */

export interface HealthComponent {
  key: "orphans" | "dead_ends" | "losers" | "backlog" | "staleness";
  label: string;
  weight: number;
  /** 0-1 normalized penalty (1 = worst). */
  penalty: number;
  /** Points deducted from 100 (weight × penalty). */
  deduction: number;
  /** Raw count/value behind the penalty. */
  raw: number;
  detail: string;
}

export interface HealthScore {
  score: number;
  label: "excellent" | "good" | "fair" | "needs_work" | "critical";
  components: HealthComponent[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function scoreLabel(score: number): HealthScore["label"] {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 60) return "fair";
  if (score >= 40) return "needs_work";
  return "critical";
}

export async function computeHealthScore(): Promise<HealthScore> {
  const [statsRow, loserRow, backlogRows, staleRow] = await Promise.all([
    db
      .select({
        pages: sql<number>`count(*)::int`,
        orphans: sql<number>`count(*) FILTER (WHERE is_orphan)::int`,
        deadEnds: sql<number>`count(*) FILTER (WHERE is_dead_end)::int`,
      })
      .from(linkStatsTable),
    db
      .select({ n: sql<number>`count(DISTINCT url)::int` })
      .from(queryLosersTable)
      .where(
        sql`week_of = (SELECT max(week_of) FROM query_losers) AND severity IN ('critical', 'high')`,
      ),
    Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(linkSuggestionsTable)
        .where(eq(linkSuggestionsTable.status, "pending_review")),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(optimizeQueueTable)
        .where(eq(optimizeQueueTable.status, "optimize")),
    ]),
    db.execute(sql`SELECT max(snapshot_date)::text AS last_date FROM gsc_snapshots`) as unknown as Promise<{
      rows: Array<{ last_date: string | null }>;
    }>,
  ]);

  const pages = statsRow[0]?.pages ?? 0;
  const orphans = statsRow[0]?.orphans ?? 0;
  const deadEnds = statsRow[0]?.deadEnds ?? 0;
  const loserPages = loserRow[0]?.n ?? 0;
  const backlog = (backlogRows[0][0]?.n ?? 0) + (backlogRows[1][0]?.n ?? 0);
  const lastSnapshot = staleRow.rows?.[0]?.last_date ?? null;
  const staleDays = lastSnapshot
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSnapshot).getTime()) / 86_400_000))
    : 30;

  const components: HealthComponent[] = [
    {
      key: "orphans",
      label: "Orphan pages",
      weight: 30,
      penalty: clamp01(pages > 0 ? orphans / pages / 0.25 : 0),
      deduction: 0,
      raw: orphans,
      detail:
        pages > 0
          ? `${orphans} of ${pages} tracked pages have no inbound internal links`
          : "No crawl data yet",
    },
    {
      key: "dead_ends",
      label: "Dead-end pages",
      weight: 20,
      penalty: clamp01(pages > 0 ? deadEnds / pages / 0.25 : 0),
      deduction: 0,
      raw: deadEnds,
      detail:
        pages > 0
          ? `${deadEnds} of ${pages} tracked pages link out to nothing`
          : "No crawl data yet",
    },
    {
      key: "losers",
      label: "Ranking drops",
      weight: 25,
      penalty: clamp01(loserPages / 20),
      deduction: 0,
      raw: loserPages,
      detail:
        loserPages === 0
          ? "No critical or high ranking drops this week"
          : `${loserPages} page${loserPages === 1 ? "" : "s"} with critical/high ranking drops this week`,
    },
    {
      key: "backlog",
      label: "Work backlog",
      weight: 15,
      penalty: clamp01(backlog / 150),
      deduction: 0,
      raw: backlog,
      detail: `${backlog} pending link suggestions and queued optimizations`,
    },
    {
      key: "staleness",
      label: "Data freshness",
      weight: 10,
      penalty: clamp01(staleDays / 14),
      deduction: 0,
      raw: staleDays,
      detail: lastSnapshot
        ? `Last Search Console sync ${staleDays === 0 ? "today" : `${staleDays} day${staleDays === 1 ? "" : "s"} ago`}`
        : "Search Console has never synced",
    },
  ];

  let score = 100;
  for (const c of components) {
    c.penalty = Math.round(c.penalty * 1000) / 1000;
    c.deduction = Math.round(c.weight * c.penalty * 10) / 10;
    score -= c.deduction;
  }
  score = Math.max(0, Math.round(score));

  return { score, label: scoreLabel(score), components };
}

/** Upsert today's snapshot (called at the end of every action-queue recompute). */
export async function persistHealthSnapshot(): Promise<void> {
  try {
    const health = await computeHealthScore();
    const today = new Date().toISOString().slice(0, 10);
    await withDbRetry(
      () =>
        db
          .insert(healthSnapshotsTable)
          .values({
            snapshotDate: today,
            score: health.score,
            components: { label: health.label, components: health.components },
          })
          .onConflictDoUpdate({
            target: healthSnapshotsTable.snapshotDate,
            set: {
              score: health.score,
              components: { label: health.label, components: health.components },
            },
          }),
      { label: "health:snapshot" },
    );
    logger.info({ score: health.score }, "Health snapshot persisted");
  } catch (e) {
    // Snapshot persistence must never fail the parent job.
    logger.warn({ err: e }, "Health snapshot persist failed");
  }
}

export async function getHealthTrend(limit = 26): Promise<Array<{ date: string; score: number }>> {
  const rows = await db
    .select({ date: healthSnapshotsTable.snapshotDate, score: healthSnapshotsTable.score })
    .from(healthSnapshotsTable)
    .orderBy(desc(healthSnapshotsTable.snapshotDate))
    .limit(limit);
  return rows.reverse().map((r) => ({ date: r.date, score: r.score }));
}
