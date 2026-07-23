// Daily refresh of the per-site persistent "Target Keyword Daily Movement"
// Google Sheet. GSC + Sheets only — no crawling, no paid fetches, no AI (see
// the tracked-submissions cost rule). No-ops when no tracked URL has a keyword.
// Each site has its own spreadsheet id (app_state key keyword_movement_sheet_id
// for the legacy site, keyword_movement_sheet_id:<siteId> for others).
import {
  exportKeywordMovementSheet,
  NoTrackedKeywordsError,
} from "../services/keywordMovementSheet";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

export async function runSyncKeywordSheet(site: SiteContext): Promise<void> {
  try {
    const result = await exportKeywordMovementSheet(90, site);
    logger.info(
      { siteId: site.id, keywordCount: result.keywordCount, title: result.title },
      "Keyword movement sheet refreshed",
    );
  } catch (e) {
    if (e instanceof NoTrackedKeywordsError) {
      logger.info(
        { siteId: site.id },
        "sync_keyword_sheet skipped — no tracked keywords",
      );
      return;
    }
    throw e;
  }
}
