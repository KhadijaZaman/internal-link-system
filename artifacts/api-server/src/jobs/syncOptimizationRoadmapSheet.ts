import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import {
  getOptimizationRoadmapSheetInfo,
  refreshOptimizationRoadmapSheet,
} from "../services/optimizationRoadmapSheet";

/**
 * Scheduled/manual refresh for a roadmap that has already been bound once.
 * Sites without a configured workbook skip cleanly: the scheduler must never
 * create a duplicate or guess which user-owned spreadsheet to overwrite.
 */
export async function runSyncOptimizationRoadmapSheet(site: SiteContext): Promise<void> {
  const info = await getOptimizationRoadmapSheetInfo(site.id);
  if (!info.url) {
    logger.info(
      { siteId: site.id },
      "sync_optimization_roadmap_sheet skipped — no workbook bound",
    );
    return;
  }
  await refreshOptimizationRoadmapSheet(site);
}
