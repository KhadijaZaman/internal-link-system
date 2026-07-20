import cron from "node-cron";
import { registerJob, runJob } from "./runner";
import { runCrawlLinkMap } from "./crawlLinkMap";
import { runGscInventoryAndLosers } from "./gscInventory";
import { runOptimizeQueuedUrls } from "./optimizeUrls";
import { runCrawlWordpress, runReembedAll } from "./crawlWordpress";
import { runSemanticLinking } from "./semanticLinking";
import { runAuditOrphans, runAuditOverLinked, runAuditBrokenLinks } from "./audits";
import { runFullPipeline } from "./runFullPipeline";
import { runRecomputeActionQueue } from "../services/actionQueue";
import { runWeeklyDigest } from "../services/digest";
import { runKeywordClustering } from "./keywordClustering";
import { runMigrateUrlHygiene } from "./migrateUrlHygiene";
import { runSyncGa4Pages } from "./syncGa4Pages";
import { logger } from "../lib/logger";

export function setupJobs(): void {
  registerJob("crawl_link_map", runCrawlLinkMap);
  registerJob("gsc_inventory_and_losers", runGscInventoryAndLosers);
  // NOTE: `find_link_suggestions` (legacy Claude-only) is intentionally NOT
  // registered. The semantic linking engine (semantic-v1) replaces it.
  // Legacy suggestion rows are preserved in the DB tagged engineVersion=legacy-v0.
  registerJob("optimize_queued_urls", runOptimizeQueuedUrls);
  registerJob("crawl_wordpress", runCrawlWordpress);
  registerJob("reembed_wordpress", runReembedAll);
  registerJob("semantic_linking", runSemanticLinking);
  registerJob("audit_orphans", runAuditOrphans);
  registerJob("audit_over_linked", runAuditOverLinked);
  registerJob("audit_broken_links", runAuditBrokenLinks);
  registerJob("run_full_pipeline", runFullPipeline);
  // Cheap (pure SQL) — also chained onto the end of the crawl/GSC/semantic
  // jobs, so this manual trigger is mostly for on-demand refreshes.
  registerJob("recompute_action_queue", runRecomputeActionQueue);
  // Pure SQL weekly summary — no AI spend.
  registerJob("weekly_digest", runWeeklyDigest);
  // Paid DataForSEO SERP scraping — on-demand only, NEVER on a cron.
  registerJob("keyword_clustering", runKeywordClustering);
  // One-shot retroactive URL-hygiene migration (idempotent) — manual only.
  registerJob("migrate_url_hygiene", runMigrateUrlHygiene);
  // GA4 key events + AI sessions → pages registry (one runReport per run).
  registerJob("sync_ga4_pages", runSyncGa4Pages);
}

export function startScheduler(): void {
  // Sunday 02:00 UTC — WordPress crawl (replaces sitemap-only crawl)
  cron.schedule("0 2 * * 0", () => void runJob("crawl_wordpress"), { timezone: "UTC" });
  // Monday 03:00 UTC
  cron.schedule("0 3 * * 1", () => void runJob("gsc_inventory_and_losers"), { timezone: "UTC" });
  // Monday 03:30 UTC — GA4 rollups after the GSC sync has refreshed pages
  cron.schedule("30 3 * * 1", () => void runJob("sync_ga4_pages"), { timezone: "UTC" });
  // Tuesday 06:00 UTC — semantic linking engine (SOP §7.2). This replaces
  // the legacy `find_link_suggestions` Claude-only weekly job.
  cron.schedule("0 6 * * 2", () => void runJob("semantic_linking"), { timezone: "UTC" });
  // Weekly audits — Thursday 07:00–09:00 UTC, staggered
  cron.schedule("0 7 * * 4", () => void runJob("audit_orphans"), { timezone: "UTC" });
  cron.schedule("0 8 * * 4", () => void runJob("audit_over_linked"), { timezone: "UTC" });
  cron.schedule("0 9 * * 4", () => void runJob("audit_broken_links"), { timezone: "UTC" });
  // NOTE: `optimize_queued_urls` (brief generation) is NO LONGER on a cron.
  // Briefs are an on-demand, paid-token operation — they only run when an
  // admin explicitly clicks "Run now" on the dashboard or POSTs to
  // /api/jobs/optimize_queued_urls/run. The job is still registered above so
  // manual triggers work; it has been removed from the weekly schedule to
  // prevent surprise OpenAI/SERP spend.
  // Monthly: 1st of month 01:00 UTC — full re-embed (also re-crawls + re-classifies)
  cron.schedule("0 1 1 * *", () => void runJob("reembed_wordpress"), { timezone: "UTC" });
  // Sitemap crawl kept as fallback weekly cross-check, Saturday 02:00 UTC
  cron.schedule("0 2 * * 6", () => void runJob("crawl_link_map"), { timezone: "UTC" });
  // Friday 10:00 UTC — weekly digest (after Thursday's audits have refreshed signals)
  cron.schedule("0 10 * * 5", () => void runJob("weekly_digest"), { timezone: "UTC" });
  logger.info(
    "Cron schedules registered (UTC: Sun02 WP crawl, Mon03 GSC, Tue06 semantic_linking, " +
      "Thu07/08/09 audits (orphans/over_linked/broken_links), Sat02 sitemap, monthly-01 reembed). " +
      "optimize_queued_urls is on-demand only — no cron.",
  );
}
