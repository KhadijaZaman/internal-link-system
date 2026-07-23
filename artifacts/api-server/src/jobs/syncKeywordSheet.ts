// Daily refresh of the persistent "Target Keyword Daily Movement" Google
// Sheet. GSC + Sheets only — no crawling, no paid fetches, no AI (see the
// tracked-submissions cost rule). No-ops when no tracked URL has a keyword.
import {
  exportKeywordMovementSheet,
  NoTrackedKeywordsError,
} from "../services/keywordMovementSheet";
import { LEGACY_SITE_ID, type SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

export async function runSyncKeywordSheet(site: SiteContext): Promise<void> {
  // The persistent movement sheet is legacy-bound (a single operator-owned
  // spreadsheet keyed on the legacy site). Non-legacy sites are a no-op.
  if (site.id !== LEGACY_SITE_ID) {
    logger.info(
      { siteId: site.id },
      "sync_keyword_sheet skipped — legacy-bound sheet, non-legacy site",
    );
    return;
  }
  try {
    const result = await exportKeywordMovementSheet(90, site.id);
    logger.info(
      { keywordCount: result.keywordCount, title: result.title },
      "Keyword movement sheet refreshed",
    );
  } catch (e) {
    if (e instanceof NoTrackedKeywordsError) {
      logger.info("sync_keyword_sheet skipped — no tracked keywords");
      return;
    }
    throw e;
  }
}
