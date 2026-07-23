import { sql, desc, gte, and, lt, isNotNull, eq } from "drizzle-orm";
import { db, actionItemsTable, digestsTable, healthSnapshotsTable } from "@workspace/db";
import { computeImpactWins } from "./impact";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";

/**
 * Weekly digest — a Friday-morning summary of the week so the operator
 * never has to reconstruct "what happened" from five different pages:
 *
 *   - health score now vs. a week ago (health_snapshots)
 *   - new issues the system surfaced this week (action_items created)
 *   - work completed this week (action_items done, manual + auto)
 *   - impact wins (pages that improved after being worked on)
 *
 * Pure SQL/arithmetic — no AI spend. One row per ISO week (Monday date),
 * upserted so a manual re-run refreshes the same week.
 */

export interface DigestActionRef {
  actionType: string;
  targetUrl: string;
  title: string | null;
  score: number;
}

export interface DigestPayload {
  weekOf: string;
  generatedAt: string;
  health: {
    current: number | null;
    previous: number | null;
    delta: number | null;
    label: string | null;
  };
  newIssues: {
    total: number;
    byType: Record<string, number>;
    top: DigestActionRef[];
  };
  completed: {
    total: number;
    auto: number;
    manual: number;
    top: Array<DigestActionRef & { resolution: string | null }>;
  };
  wins: {
    improved: number;
    measuring: number;
    flat: number;
    declined: number;
    top: Array<{
      path: string;
      url: string;
      state: string;
      deltaClicks: number | null;
      deltaImpressions: number | null;
    }>;
  };
  openActions: number;
}

/** Monday of the ISO week containing the given date (UTC), as YYYY-MM-DD. */
function isoWeekMonday(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function scoreLabelOf(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 60) return "fair";
  if (score >= 40) return "needs_work";
  return "critical";
}

export async function computeWeeklyDigest(siteId: number, now = new Date()): Promise<DigestPayload> {
  const weekOf = isoWeekMonday(now);
  const weekStart = new Date(`${weekOf}T00:00:00.000Z`);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const [currentSnap, previousSnap, createdRows, completedRows, openRow, winsResult] =
    await Promise.all([
      db
        .select({ score: healthSnapshotsTable.score })
        .from(healthSnapshotsTable)
        .where(eq(healthSnapshotsTable.siteId, siteId))
        .orderBy(desc(healthSnapshotsTable.snapshotDate))
        .limit(1),
      db
        .select({ score: healthSnapshotsTable.score })
        .from(healthSnapshotsTable)
        .where(and(eq(healthSnapshotsTable.siteId, siteId), lt(healthSnapshotsTable.snapshotDate, weekOf)))
        .orderBy(desc(healthSnapshotsTable.snapshotDate))
        .limit(1),
      db
        .select({
          actionType: actionItemsTable.actionType,
          targetUrl: actionItemsTable.targetUrl,
          title: actionItemsTable.title,
          score: actionItemsTable.score,
        })
        .from(actionItemsTable)
        .where(
          and(
            eq(actionItemsTable.siteId, siteId),
            gte(actionItemsTable.createdAt, weekStart),
            lt(actionItemsTable.createdAt, weekEnd),
          ),
        )
        .orderBy(desc(actionItemsTable.score)),
      db
        .select({
          actionType: actionItemsTable.actionType,
          targetUrl: actionItemsTable.targetUrl,
          title: actionItemsTable.title,
          score: actionItemsTable.score,
          resolution: actionItemsTable.resolution,
        })
        .from(actionItemsTable)
        .where(
          and(
            eq(actionItemsTable.siteId, siteId),
            eq(actionItemsTable.status, "done"),
            isNotNull(actionItemsTable.completedAt),
            gte(actionItemsTable.completedAt, weekStart),
            lt(actionItemsTable.completedAt, weekEnd),
          ),
        )
        .orderBy(desc(actionItemsTable.score)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(actionItemsTable)
        .where(and(eq(actionItemsTable.siteId, siteId), eq(actionItemsTable.status, "open"))),
      computeImpactWins(siteId),
    ]);

  const current = currentSnap[0]?.score ?? null;
  const previous = previousSnap[0]?.score ?? null;

  const byType: Record<string, number> = {};
  for (const r of createdRows) byType[r.actionType] = (byType[r.actionType] ?? 0) + 1;

  const winsTop = winsResult.items
    .filter((w) => w.state === "improved")
    .slice(0, 5)
    .map((w) => ({
      path: w.path,
      url: w.url,
      state: w.state,
      deltaClicks: w.deltaClicks,
      deltaImpressions: w.deltaImpressions,
    }));

  return {
    weekOf,
    generatedAt: new Date().toISOString(),
    health: {
      current,
      previous,
      delta: current != null && previous != null ? current - previous : null,
      label: scoreLabelOf(current),
    },
    newIssues: {
      total: createdRows.length,
      byType,
      top: createdRows.slice(0, 5).map((r) => ({
        actionType: r.actionType,
        targetUrl: r.targetUrl,
        title: r.title,
        score: r.score,
      })),
    },
    completed: {
      total: completedRows.length,
      auto: completedRows.filter((r) => r.resolution === "auto").length,
      manual: completedRows.filter((r) => r.resolution !== "auto").length,
      top: completedRows.slice(0, 5).map((r) => ({
        actionType: r.actionType,
        targetUrl: r.targetUrl,
        title: r.title,
        score: r.score,
        resolution: r.resolution,
      })),
    },
    wins: {
      improved: winsResult.summary.improved,
      measuring: winsResult.summary.measuring,
      flat: winsResult.summary.flat,
      declined: winsResult.summary.declined,
      top: winsTop,
    },
    openActions: openRow[0]?.n ?? 0,
  };
}

/** Job entrypoint — upserts this ISO week's digest row. */
export async function runWeeklyDigest(site: SiteContext): Promise<void> {
  const payload = await computeWeeklyDigest(site.id);
  await withDbRetry(
    () =>
      db
        .insert(digestsTable)
        .values({
          siteId: site.id,
          weekOf: payload.weekOf,
          payload: payload as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [digestsTable.siteId, digestsTable.weekOf],
          set: { payload: payload as unknown as Record<string, unknown> },
        }),
    { label: "digest:upsert" },
  );
  logger.info({ weekOf: payload.weekOf }, "Weekly digest generated");
}
