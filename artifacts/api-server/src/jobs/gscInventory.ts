import { db, gscSnapshotsTable, queryLosersTable, inventoryTable } from "@workspace/db";
import { queryGsc, type GscRow } from "../integrations/gsc";
import { sectionFor } from "../lib/sections";
import { chainActionQueueRecompute } from "../services/actionQueue";
import { logger } from "../lib/logger";

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Weekly impressions below this produce position averages from a handful of
 * auctions — any "movement" at that volume is statistical noise, not a loss.
 */
const MIN_IMPRESSIONS_FOR_SIGNAL = 10;
/** Impression-drop severities need a real base to compute a meaningful %. */
const MIN_IMPRESSIONS_FOR_PCT = 30;

function classifySeverity(
  prevPos: number,
  currPos: number,
  prevImp: number,
  currImp: number,
): string | null {
  // Noise floor: ignore url+query pairs with negligible search volume.
  if (Math.max(prevImp, currImp) < MIN_IMPRESSIONS_FOR_SIGNAL) return null;
  const posChange = currPos - prevPos;
  const impPct = prevImp > 0 ? ((currImp - prevImp) / prevImp) * 100 : 0;
  if (prevPos <= 3 && currPos > 3) return "critical";
  // Position-delta rules only matter where positions are stable enough to
  // trust (page 1-2). A 45 → 48 wobble is not a "high" severity loss.
  if ((prevPos <= 10 && currPos > 10) || (posChange >= 3 && prevPos <= 20)) return "high";
  if (impPct <= -30 && prevPos <= 20 && prevImp >= MIN_IMPRESSIONS_FOR_PCT) return "medium";
  if (
    (posChange >= 1.5 && prevPos <= 20) ||
    (impPct <= -15 && prevImp >= MIN_IMPRESSIONS_FOR_PCT)
  ) {
    return "low";
  }
  return null;
}

export async function runGscInventoryAndLosers(): Promise<void> {
  // GSC data for the most recent ~2-3 days is incomplete (processing lag), so
  // both windows end 3 days back. 7-day windows keep weekday mix identical.
  const currStart = dateOffset(9);
  const currEnd = dateOffset(3);
  const prevStart = dateOffset(16);
  const prevEnd = dateOffset(10);
  logger.info({ currStart, currEnd, prevStart, prevEnd }, "GSC: pulling rows");

  const curr = await queryGsc({ startDate: currStart, endDate: currEnd });
  const prev = await queryGsc({ startDate: prevStart, endDate: prevEnd });
  logger.info({ curr: curr.length, prev: prev.length }, "GSC: rows pulled");

  const today = new Date().toISOString().slice(0, 10);
  if (curr.length > 0) {
    const batch = curr.map((r) => ({
      snapshotDate: today,
      url: r.url,
      query: r.query,
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
    }));
    for (let i = 0; i < batch.length; i += 500) {
      await db.insert(gscSnapshotsTable).values(batch.slice(i, i + 500));
    }
  }

  const prevMap = new Map<string, GscRow>();
  for (const r of prev) prevMap.set(`${r.url}||${r.query}`, r);

  const losers: Array<typeof queryLosersTable.$inferInsert> = [];
  for (const r of curr) {
    const p = prevMap.get(`${r.url}||${r.query}`);
    if (!p) continue;
    const sev = classifySeverity(p.position, r.position, p.impressions, r.impressions);
    if (!sev) continue;
    losers.push({
      weekOf: today,
      url: r.url,
      query: r.query,
      prevPosition: p.position,
      currPosition: r.position,
      positionChange: r.position - p.position,
      prevImpressions: p.impressions,
      currImpressions: r.impressions,
      impressionsChangePct:
        p.impressions > 0 ? ((r.impressions - p.impressions) / p.impressions) * 100 : null,
      severity: sev,
    });
  }
  for (let i = 0; i < losers.length; i += 500) {
    if (losers.length > 0) await db.insert(queryLosersTable).values(losers.slice(i, i + 500));
  }
  logger.info({ losers: losers.length }, "GSC: losers computed");

  // Rebuild inventory: for each URL, pick row with highest impressions
  const byUrl = new Map<string, GscRow>();
  for (const r of curr) {
    const existing = byUrl.get(r.url);
    if (!existing || r.impressions > existing.impressions) byUrl.set(r.url, r);
  }
  for (const [url, r] of byUrl) {
    await db
      .insert(inventoryTable)
      .values({
        url,
        section: sectionFor(url),
        topQuery: r.query,
        position: r.position,
        impressions: r.impressions,
        clicks: r.clicks,
        lastUpdated: new Date(),
      })
      .onConflictDoUpdate({
        target: inventoryTable.url,
        set: {
          section: sectionFor(url),
          topQuery: r.query,
          position: r.position,
          impressions: r.impressions,
          clicks: r.clicks,
          lastUpdated: new Date(),
        },
      });
  }
  logger.info({ urls: byUrl.size }, "GSC: inventory updated");

  // Fresh inventory + losers change action priorities — refresh the queue.
  await chainActionQueueRecompute("gsc_inventory_and_losers");
}
