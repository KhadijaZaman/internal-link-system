import {
  db,
  gscSnapshotsTable,
  queryLosersTable,
  inventoryTable,
  pagesTable,
} from "@workspace/db";
import { queryGsc, type GscRow } from "../integrations/gsc";
import {
  canonicalPath,
  canonicalUrl,
  isBlockedPath,
  loadBlockRegexes,
  mergeMetricRows,
} from "../lib/urlCanon";
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

interface CanonRow {
  path: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  ctr: number;
}

/**
 * Collapse raw GSC rows (which record #fragment / ?query / trailing-slash
 * variants of the same page as separate URLs) onto (canonical path, query):
 * clicks/impressions summed, position impression-weighted. Blocklisted and
 * foreign-host rows are dropped here so they never reach any table.
 */
function collapseRows(rows: GscRow[], block: RegExp[]): Map<string, CanonRow> {
  const groups = new Map<string, GscRow[]>();
  const paths = new Map<string, string>();
  for (const r of rows) {
    const path = canonicalPath(r.url);
    if (!path || isBlockedPath(path, block)) continue;
    const key = `${path}||${r.query}`;
    paths.set(key, path);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, CanonRow>();
  for (const [key, g] of groups) {
    const m = mergeMetricRows(g);
    const path = paths.get(key)!;
    out.set(key, {
      path,
      query: key.slice(path.length + 2),
      clicks: m.clicks,
      impressions: m.impressions,
      position: m.position,
      ctr: m.ctr,
    });
  }
  return out;
}

export async function runGscInventoryAndLosers(): Promise<void> {
  // GSC data for the most recent ~2-3 days is incomplete (processing lag), so
  // both windows end 3 days back. 7-day windows keep weekday mix identical.
  const currStart = dateOffset(9);
  const currEnd = dateOffset(3);
  const prevStart = dateOffset(16);
  const prevEnd = dateOffset(10);
  logger.info({ currStart, currEnd, prevStart, prevEnd }, "GSC: pulling rows");

  const [currRaw, prevRaw, block] = await Promise.all([
    queryGsc({ startDate: currStart, endDate: currEnd }),
    queryGsc({ startDate: prevStart, endDate: prevEnd }),
    loadBlockRegexes(),
  ]);
  const curr = collapseRows(currRaw, block);
  const prev = collapseRows(prevRaw, block);
  logger.info(
    { currRaw: currRaw.length, curr: curr.size, prevRaw: prevRaw.length, prev: prev.size },
    "GSC: rows pulled (raw → canonical)",
  );

  const today = new Date().toISOString().slice(0, 10);
  if (curr.size > 0) {
    const batch = [...curr.values()].map((r) => ({
      snapshotDate: today,
      url: canonicalUrl(r.path),
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

  const losers: Array<typeof queryLosersTable.$inferInsert> = [];
  for (const [key, r] of curr) {
    const p = prev.get(key);
    if (!p) continue;
    const sev = classifySeverity(p.position, r.position, p.impressions, r.impressions);
    if (!sev) continue;
    losers.push({
      weekOf: today,
      url: canonicalUrl(r.path),
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

  // Rebuild inventory: for each canonical path, pick query with highest impressions
  const byPath = new Map<string, CanonRow>();
  for (const r of curr.values()) {
    const existing = byPath.get(r.path);
    if (!existing || r.impressions > existing.impressions) byPath.set(r.path, r);
  }
  const now = new Date();
  for (const [path, r] of byPath) {
    const url = canonicalUrl(path);
    const section = sectionFor(url);
    await db
      .insert(inventoryTable)
      .values({
        url,
        section,
        topQuery: r.query,
        position: r.position,
        impressions: r.impressions,
        clicks: r.clicks,
        lastUpdated: now,
      })
      .onConflictDoUpdate({
        target: inventoryTable.url,
        set: {
          section,
          topQuery: r.query,
          position: r.position,
          impressions: r.impressions,
          clicks: r.clicks,
          lastUpdated: now,
        },
      });
    // Canonical page registry: GSC is one of the sources that "sees" a page.
    await db
      .insert(pagesTable)
      .values({
        path,
        url,
        section,
        inGsc: true,
        topQuery: r.query,
        position: r.position,
        impressions: r.impressions,
        clicks: r.clicks,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pagesTable.path,
        set: {
          inGsc: true,
          section,
          topQuery: r.query,
          position: r.position,
          impressions: r.impressions,
          clicks: r.clicks,
          updatedAt: now,
        },
      });
  }
  logger.info({ urls: byPath.size }, "GSC: inventory + pages updated");

  // Fresh inventory + losers change action priorities — refresh the queue.
  await chainActionQueueRecompute("gsc_inventory_and_losers");
}
