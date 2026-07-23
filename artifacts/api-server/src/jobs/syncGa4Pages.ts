import { db, pagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { queryGa4Pages } from "../integrations/ga4";
import { withDbRetry } from "../lib/dbRetry";
import { getLegacySite } from "../lib/site";
import { logger } from "../lib/logger";

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Rolls 28 days of GA4 key events (signups + demo bookings) and AI-referral
 * sessions onto the canonical pages registry. UPDATE-only by design: GA4
 * landing pages must never grow the registry — pages are created by the
 * WP/GSC/sitemap ingestion paths, all of which share the canonical
 * normalizer, so GA4 paths join cleanly here.
 */
export async function runSyncGa4Pages(): Promise<void> {
  // GA4 sync stays legacy-site-only until per-site job scheduling lands.
  const site = await getLegacySite();
  const startDate = dateOffset(28);
  const endDate = dateOffset(1);
  // channel:"all" — stored rollups are all-channel totals; the per-channel
  // split stays a live-view concern.
  const { rows } = await queryGa4Pages({ startDate, endDate, channel: "all", site });
  const now = new Date();

  // One transaction: reset (so pages that stopped converting don't keep
  // stale counts, stamping sync time on every row) + per-page updates.
  // Readers never see the mid-job all-zeros state, and a crash mid-loop
  // rolls back to the previous rollup instead of leaving zeros. The whole
  // transaction is idempotent, so withDbRetry can safely re-run it.
  let updated = 0;
  let unmatched = 0;
  await withDbRetry(
    () =>
      db.transaction(async (tx) => {
        updated = 0;
        unmatched = 0;
        await tx
          .update(pagesTable)
          .set({ keyEvents: 0, aiSessions: 0, ga4SyncedAt: now })
          .where(eq(pagesTable.siteId, site.id));
        for (const r of rows) {
          if (r.keyEvents === 0 && r.aiSessions === 0) continue;
          const result = await tx
            .update(pagesTable)
            .set({ keyEvents: r.keyEvents, aiSessions: r.aiSessions, updatedAt: now })
            .where(and(eq(pagesTable.siteId, site.id), eq(pagesTable.path, r.path)));
          if ((result.rowCount ?? 0) > 0) updated++;
          else unmatched++;
        }
      }),
    { label: "ga4_sync:apply" },
  );
  logger.info(
    { startDate, endDate, ga4Rows: rows.length, updated, unmatched },
    "sync_ga4_pages complete",
  );
}
