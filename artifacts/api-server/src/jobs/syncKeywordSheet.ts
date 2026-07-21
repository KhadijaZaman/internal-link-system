// Daily refresh of the persistent "Target Keyword Daily Movement" Google
// Sheet. GSC + Sheets only — no crawling, no paid fetches, no AI (see the
// tracked-submissions cost rule). No-ops when no tracked URL has a keyword.
import {
  exportKeywordMovementSheet,
  NoTrackedKeywordsError,
} from "../services/keywordMovementSheet";
import { logger } from "../lib/logger";

export async function runSyncKeywordSheet(): Promise<void> {
  try {
    const result = await exportKeywordMovementSheet(90);
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
