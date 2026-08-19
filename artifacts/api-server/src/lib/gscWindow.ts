import { db, appStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/** YYYY-MM-DD for `days` days before the given moment (UTC). */
export function isoDateOffsetFrom(from: Date, days: number): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** app_state key scoping helpers — mirrors the pattern used by keyword-movement sheet ids. */
export function gscWindowStartKey(siteId: number): string {
  return `gsc_window_start:${siteId}`;
}
export function gscWindowEndKey(siteId: number): string {
  return `gsc_window_end:${siteId}`;
}

/**
 * Persist the GSC query window that was **actually applied** to the rollup
 * tables.  Call this only after rows have been written to pagesTable so the
 * stored dates always match the live data.
 */
export async function persistGscWindow(
  siteId: number,
  windowStart: string,
  windowEnd: string,
): Promise<void> {
  await db
    .insert(appStateTable)
    .values([
      { key: gscWindowStartKey(siteId), value: windowStart },
      { key: gscWindowEndKey(siteId), value: windowEnd },
    ])
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: appStateTable.value, updatedAt: new Date() },
    });
}

/**
 * Returns the 7-day GSC window that the stored rollups cover.
 *
 * Dates come from app_state written by runGscInventoryAndLosers only after it
 * has successfully fetched and applied GSC data.  A graceful skip (e.g. GSC
 * disconnected) never writes to app_state, so the prior window — or null when
 * the job has never successfully applied data — is returned unchanged.
 */
export async function loadGscWindow(
  siteId: number,
): Promise<{ gscWindowStart: string | null; gscWindowEnd: string | null }> {
  const [startRow, endRow] = await Promise.all([
    db
      .select({ value: appStateTable.value })
      .from(appStateTable)
      .where(eq(appStateTable.key, gscWindowStartKey(siteId)))
      .limit(1),
    db
      .select({ value: appStateTable.value })
      .from(appStateTable)
      .where(eq(appStateTable.key, gscWindowEndKey(siteId)))
      .limit(1),
  ]);
  return {
    gscWindowStart: startRow[0]?.value ?? null,
    gscWindowEnd: endRow[0]?.value ?? null,
  };
}
