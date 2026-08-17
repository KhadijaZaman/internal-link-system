// Daily refresh of the per-site persistent "Link Map" Google Sheet.
// Sheets only — no crawling, no paid fetches, no AI.
// Skips sites that have never exported a sheet (no stored sheet ID).
// Skips sites with no link data (NoLinkDataError).
// Each site failure is logged and does not stop other sites from syncing.
import {
  exportLinkMapSheet,
  getStoredLinkMapSheetUrl,
  NoLinkDataError,
} from "../services/linkMapSheet";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

export async function runSyncLinkMapSheet(site: SiteContext): Promise<void> {
  // Only refresh sheets the user has already created via the manual export.
  const existingUrl = await getStoredLinkMapSheetUrl(site.id);
  if (!existingUrl) {
    logger.info(
      { siteId: site.id },
      "sync_link_map_sheet skipped — no sheet exported yet",
    );
    return;
  }

  try {
    const result = await exportLinkMapSheet(site);
    logger.info(
      { siteId: site.id, rowCount: result.rowCount, title: result.title },
      "Link map sheet refreshed",
    );
  } catch (e) {
    if (e instanceof NoLinkDataError) {
      logger.info(
        { siteId: site.id },
        "sync_link_map_sheet skipped — no link data",
      );
      return;
    }
    throw e;
  }
}
