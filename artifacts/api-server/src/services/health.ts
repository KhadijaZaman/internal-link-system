import { sql, desc, asc, and, eq, lte, lt } from "drizzle-orm";
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

export async function computeHealthScore(siteId: number): Promise<HealthScore> {
  const [statsRow, loserRow, backlogRows, staleRow] = await Promise.all([
    db
      .select({
        pages: sql<number>`count(*)::int`,
        orphans: sql<number>`count(*) FILTER (WHERE is_orphan)::int`,
        deadEnds: sql<number>`count(*) FILTER (WHERE is_dead_end)::int`,
      })
      .from(linkStatsTable)
      .where(eq(linkStatsTable.siteId, siteId)),
    db
      .select({ n: sql<number>`count(DISTINCT url)::int` })
      .from(queryLosersTable)
      .where(
        sql`site_id = ${siteId} AND week_of = (SELECT max(week_of) FROM query_losers WHERE site_id = ${siteId}) AND severity IN ('critical', 'high')`,
      ),
    Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(linkSuggestionsTable)
        .where(and(eq(linkSuggestionsTable.status, "pending_review"), eq(linkSuggestionsTable.siteId, siteId))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(optimizeQueueTable)
        .where(and(eq(optimizeQueueTable.status, "optimize"), eq(optimizeQueueTable.siteId, siteId))),
    ]),
    db.execute(sql`SELECT max(snapshot_date)::text AS last_date FROM gsc_snapshots WHERE site_id = ${siteId}`) as unknown as Promise<{
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
export async function persistHealthSnapshot(siteId: number): Promise<void> {
  try {
    const health = await computeHealthScore(siteId);
    const today = new Date().toISOString().slice(0, 10);
    await withDbRetry(
      () =>
        db
          .insert(healthSnapshotsTable)
          .values({
            siteId,
            snapshotDate: today,
            score: health.score,
            components: { label: health.label, components: health.components },
          })
          .onConflictDoUpdate({
            target: [healthSnapshotsTable.siteId, healthSnapshotsTable.snapshotDate],
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

export interface HealthDriver {
  key: HealthComponent["key"];
  label: string;
  /** How many extra points this component costs now vs the baseline (positive = worse). */
  pointsLost: number;
  rawBefore: number;
  rawAfter: number;
  deductionBefore: number;
  deductionAfter: number;
  evidence: string;
  action: string;
  /** Dashboard route where the operator can act, or null if the fix lives on the Overview page. */
  link: string | null;
}

export interface HealthDecline {
  baselineDate: string;
  baselineScore: number;
  currentScore: number;
  /** current - baseline (negative = declining). */
  scoreChange: number;
  drivers: HealthDriver[];
  improvements: HealthDriver[];
}

const DRIVER_PLAYBOOK: Record<
  HealthComponent["key"],
  { evidence: (before: number, after: number) => string; action: string; link: string | null }
> = {
  orphans: {
    evidence: (b, a) => `Pages with no inbound internal links went from ${b} to ${a}`,
    action:
      "Add internal links pointing to these pages — Structural Fixes lists them ready to work top-down.",
    link: "/links/structural",
  },
  dead_ends: {
    evidence: (b, a) => `Pages that link out to nothing went from ${b} to ${a}`,
    action:
      "Add outbound links from these pages to related articles — Structural Fixes has the list.",
    link: "/links/structural",
  },
  losers: {
    evidence: (b, a) => `Pages with critical/high ranking drops this week went from ${b} to ${a}`,
    action:
      "Open Query Losers, review the biggest drops, and queue the worst pages for optimization.",
    link: "/losers",
  },
  backlog: {
    evidence: (b, a) => `Pending link suggestions and queued optimizations went from ${b} to ${a}`,
    action: "Approve or dismiss pending link suggestions to shrink the backlog.",
    link: "/suggestions",
  },
  staleness: {
    evidence: (b, a) =>
      `Last Search Console sync moved from ${b} day${b === 1 ? "" : "s"} ago to ${a} day${a === 1 ? "" : "s"} ago`,
    action: 'Refresh the data — click "Run now" on the pipeline at the top of this page.',
    link: null,
  },
};

function parseSnapshotComponents(raw: unknown): Map<string, { raw: number; deduction: number }> {
  const out = new Map<string, { raw: number; deduction: number }>();
  if (!raw || typeof raw !== "object") return out;
  const list = (raw as { components?: unknown }).components;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as { key?: unknown; raw?: unknown; deduction?: unknown };
    if (typeof c.key !== "string" || typeof c.raw !== "number" || typeof c.deduction !== "number")
      continue;
    out.set(c.key, { raw: c.raw, deduction: c.deduction });
  }
  return out;
}

/**
 * Explain how the score moved vs a baseline snapshot: prefer the most recent
 * snapshot at least 7 days old (a stable "last week" anchor); fall back to the
 * oldest snapshot before today. Returns null when there is no prior snapshot
 * to compare against (fresh installs).
 */
export async function explainHealthChange(siteId: number, current: HealthScore): Promise<HealthDecline | null> {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  let [baseline] = await db
    .select()
    .from(healthSnapshotsTable)
    .where(and(eq(healthSnapshotsTable.siteId, siteId), lte(healthSnapshotsTable.snapshotDate, cutoff)))
    .orderBy(desc(healthSnapshotsTable.snapshotDate))
    .limit(1);
  if (!baseline) {
    [baseline] = await db
      .select()
      .from(healthSnapshotsTable)
      .where(and(eq(healthSnapshotsTable.siteId, siteId), lt(healthSnapshotsTable.snapshotDate, today)))
      .orderBy(asc(healthSnapshotsTable.snapshotDate))
      .limit(1);
  }
  if (!baseline) return null;

  const prev = parseSnapshotComponents(baseline.components);
  const drivers: HealthDriver[] = [];
  const improvements: HealthDriver[] = [];

  for (const comp of current.components) {
    const before = prev.get(comp.key);
    if (!before) continue; // can't claim a change without a baseline value
    const delta = Math.round((comp.deduction - before.deduction) * 10) / 10;
    if (Math.abs(delta) < 0.5) continue;
    const playbook = DRIVER_PLAYBOOK[comp.key];
    const entry: HealthDriver = {
      key: comp.key,
      label: comp.label,
      pointsLost: delta,
      rawBefore: before.raw,
      rawAfter: comp.raw,
      deductionBefore: before.deduction,
      deductionAfter: comp.deduction,
      evidence: playbook.evidence(before.raw, comp.raw),
      action: playbook.action,
      link: playbook.link,
    };
    if (delta > 0) drivers.push(entry);
    else improvements.push(entry);
  }
  drivers.sort((a, b) => b.pointsLost - a.pointsLost);
  improvements.sort((a, b) => a.pointsLost - b.pointsLost);

  return {
    baselineDate: baseline.snapshotDate,
    baselineScore: baseline.score,
    currentScore: current.score,
    scoreChange: current.score - baseline.score,
    drivers,
    improvements,
  };
}

export async function getHealthTrend(siteId: number, limit = 26): Promise<Array<{ date: string; score: number }>> {
  const rows = await db
    .select({ date: healthSnapshotsTable.snapshotDate, score: healthSnapshotsTable.score })
    .from(healthSnapshotsTable)
    .where(eq(healthSnapshotsTable.siteId, siteId))
    .orderBy(desc(healthSnapshotsTable.snapshotDate))
    .limit(limit);
  return rows.reverse().map((r) => ({ date: r.date, score: r.score }));
}
