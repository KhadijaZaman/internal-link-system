import cron from "node-cron";
import { registerJob, runJob, lastRunAt, type JobName } from "./runner";
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
import { runEmbedKbChunks } from "./embedKbChunks";
import { runSyncKeywordSheet } from "./syncKeywordSheet";
import { runAnalyzeSimilarity } from "./analyzeSimilarity";
import { runSyncBingPages } from "./syncBingPages";
import { runGenerateTopicalMap } from "./generateTopicalMap";
import { runAuditLinkQuality } from "./auditLinkQuality";
import { listSchedulableSites } from "../lib/site";
import { logger } from "../lib/logger";

export function setupJobs(): void {
  registerJob("crawl_link_map", runCrawlLinkMap);
  registerJob("gsc_inventory_and_losers", runGscInventoryAndLosers);
  // NOTE: `find_link_suggestions` (legacy Claude-only) is intentionally NOT
  // registered. The semantic linking engine (semantic-v1) replaces it.
  // Legacy suggestion rows are preserved in the DB tagged engineVersion=legacy-v0.
  registerJob("optimize_queued_urls", runOptimizeQueuedUrls);
  registerJob("crawl_wordpress", (site) => runCrawlWordpress(site));
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
  // Drains NULL-embedding KB chunks; triggered by KB uploads + a 10-min
  // sweep cron (no-ops when nothing is pending/partial).
  registerJob("embed_kb_chunks", runEmbedKbChunks);
  // Daily refresh of the persistent Target Keyword Daily Movement sheet —
  // GSC + Sheets only, no paid spend.
  registerJob("sync_keyword_sheet", runSyncKeywordSheet);
  // Content Similarity Explorer runs — triggered by POST /similarity/runs,
  // never on a cron (fetches arbitrary user-supplied URLs + OpenAI spend).
  registerJob("analyze_similarity", runAnalyzeSimilarity);
  // Bing Webmaster API page/query stats → bing_* tables + pages rollups.
  registerJob("sync_bing_pages", runSyncBingPages);
  // Topical Authority Map generation — triggered by POST /topical-map/generate,
  // never on a cron (Claude + OpenAI embedding spend).
  registerJob("generate_topical_map", runGenerateTopicalMap);
  // Existing-link quality audit (embeddings × edges, pure DB + math, no API
  // spend) — manual trigger from the Link Map page; re-run after re-crawls.
  registerJob("audit_link_quality", runAuditLinkQuality);
}

/**
 * Run a scheduled job for every claimed site, one site at a time. Sequential
 * so N sites never multiply concurrent external-API load, and each site's
 * failure is recorded on its own job_runs row without blocking the next site
 * (runJob catches, records, and never rethrows).
 */
export async function runJobForAllSites(name: JobName): Promise<void> {
  let sites;
  try {
    sites = await listSchedulableSites();
  } catch (e) {
    logger.error({ err: e, jobName: name }, "Scheduler: failed to list sites");
    return;
  }
  if (sites.length === 0) {
    logger.info({ jobName: name }, "Scheduler: no claimed sites; skipping");
    return;
  }
  for (const site of sites) {
    try {
      const result = await runJob(name, site);
      if (result.started) {
        await result.completion;
      } else {
        logger.warn(
          { jobName: name, siteId: site.id, reason: result.reason },
          "Scheduler: job not started for site",
        );
      }
    } catch (e) {
      // Defensive: runJob shouldn't throw, but one site must never block the rest.
      logger.error({ err: e, jobName: name, siteId: site.id }, "Scheduler: site run failed");
    }
  }
}

// Scheduled crons that must not silently fall behind when the server was
// asleep (dev workspace) or recycled (autoscale) at the scheduled minute.
// Each entry pairs a cron job with a staleness threshold = its cadence plus
// generous slack, so the sweep only fires when a scheduled run was actually
// missed, never merely because a run is "due soon". ORDER MATTERS: entries
// run top-to-bottom per sweep, so gsc_inventory_and_losers precedes
// sync_ga4_pages (GA4 rollups join onto the pages GSC refreshes), mirroring
// the Mon 03:00 → 03:30 cron ordering. Spend-sensitive on-demand jobs
// (optimize_queued_urls, keyword_clustering, analyze_similarity,
// generate_topical_map, etc.) are deliberately absent — they must never run
// without an explicit trigger. embed_kb_chunks already sweeps every 10 min.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A healthy daily job runs every 24h; 26h leaves slack for slow runs and DST.
const DAILY_MAX_AGE_MS = 26 * HOUR_MS;
// Weekly jobs get a full extra day of slack (>8 days = a week was missed).
const WEEKLY_MAX_AGE_MS = 8 * DAY_MS;
// Monthly re-embed: months vary 28-31 days; 33 days means one was skipped.
const MONTHLY_MAX_AGE_MS = 33 * DAY_MS;

// `requirePriorRun` (weekly/monthly): a site that has NEVER run the job is
// not "behind" — the regular cron will pick it up within its cadence. Without
// this, adding a new site would make the next sweep fire every heavy weekly
// job plus the monthly re-embed at once. Daily jobs keep the original
// run-if-never-run behavior (cheap, and a new site wants them same-day).
const CATCHUP_JOBS: Array<{
  name: JobName;
  maxAgeMs: number;
  requirePriorRun?: boolean;
}> = [
  // Daily
  { name: "sync_keyword_sheet", maxAgeMs: DAILY_MAX_AGE_MS },
  { name: "sync_bing_pages", maxAgeMs: DAILY_MAX_AGE_MS },
  // Weekly — GSC inventory MUST come before GA4 (ordering dependency)
  { name: "crawl_wordpress", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "gsc_inventory_and_losers", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "sync_ga4_pages", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "semantic_linking", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "audit_orphans", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "audit_over_linked", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "audit_broken_links", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "crawl_link_map", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  { name: "weekly_digest", maxAgeMs: WEEKLY_MAX_AGE_MS, requirePriorRun: true },
  // Monthly
  { name: "reembed_wordpress", maxAgeMs: MONTHLY_MAX_AGE_MS, requirePriorRun: true },
];

/**
 * Run any scheduled job whose last recorded run (per site) is older than its
 * cadence-specific threshold. Called on startup and hourly. Duplicate-safe:
 * recordJobStart bumps last_run_at as soon as a run begins, and runJob's
 * per-(job,site) lock refuses a second concurrent run, so an overlap with
 * the regular cron can never double-run. Stale "running" rows (process died
 * mid-job) have an old last_run_at, so interrupted runs are retried too.
 * Jobs run sequentially in list order, preserving the GSC→GA4 dependency.
 */
export async function runDailyCatchUp(): Promise<void> {
  let sites;
  try {
    sites = await listSchedulableSites();
  } catch (e) {
    logger.error({ err: e }, "Catch-up: failed to list sites");
    return;
  }
  for (const { name, maxAgeMs, requirePriorRun } of CATCHUP_JOBS) {
    for (const site of sites) {
      try {
        const last = await lastRunAt(name, site.id);
        if (!last && requirePriorRun) continue;
        const age = last ? Date.now() - last.getTime() : Infinity;
        if (age <= maxAgeMs) continue;
        logger.info(
          { jobName: name, siteId: site.id, lastRunAt: last ?? null },
          "Catch-up: scheduled job is overdue; running now",
        );
        const result = await runJob(name, site);
        if (result.started) {
          await result.completion;
        } else {
          logger.info(
            { jobName: name, siteId: site.id, reason: result.reason },
            "Catch-up: job not started",
          );
        }
      } catch (e) {
        logger.error(
          { err: e, jobName: name, siteId: site.id },
          "Catch-up: site run failed",
        );
      }
    }
  }
}

export function startScheduler(): void {
  const all = (name: JobName) => () => void runJobForAllSites(name);
  // Sunday 02:00 UTC — WordPress crawl (replaces sitemap-only crawl)
  cron.schedule("0 2 * * 0", all("crawl_wordpress"), { timezone: "UTC" });
  // Monday 03:00 UTC
  cron.schedule("0 3 * * 1", all("gsc_inventory_and_losers"), { timezone: "UTC" });
  // Monday 03:30 UTC — GA4 rollups after the GSC sync has refreshed pages
  cron.schedule("30 3 * * 1", all("sync_ga4_pages"), { timezone: "UTC" });
  // Tuesday 06:00 UTC — semantic linking engine (SOP §7.2). This replaces
  // the legacy `find_link_suggestions` Claude-only weekly job.
  cron.schedule("0 6 * * 2", all("semantic_linking"), { timezone: "UTC" });
  // Weekly audits — Thursday 07:00–09:00 UTC, staggered
  cron.schedule("0 7 * * 4", all("audit_orphans"), { timezone: "UTC" });
  cron.schedule("0 8 * * 4", all("audit_over_linked"), { timezone: "UTC" });
  cron.schedule("0 9 * * 4", all("audit_broken_links"), { timezone: "UTC" });
  // NOTE: `optimize_queued_urls` (brief generation) is NO LONGER on a cron.
  // Briefs are an on-demand, paid-token operation — they only run when an
  // admin explicitly clicks "Run now" on the dashboard or POSTs to
  // /api/jobs/optimize_queued_urls/run. The job is still registered above so
  // manual triggers work; it has been removed from the weekly schedule to
  // prevent surprise OpenAI/SERP spend.
  // Every 10 minutes — KB embed sweep. Uploads trigger the job directly, but
  // a doc can slip through if it lands in the instant between the running
  // job's final empty check and its shutdown ("Already running" returned, yet
  // never picked up). This sweep re-drains anything still pending and gives
  // "partial" docs (per-chunk embed failures) an automatic retry. It exits
  // immediately when there is nothing to do, so the cost of the cron is one
  // cheap SELECT.
  cron.schedule("*/10 * * * *", all("embed_kb_chunks"), { timezone: "UTC" });
  // Monthly: 1st of month 01:00 UTC — full re-embed (also re-crawls + re-classifies)
  cron.schedule("0 1 1 * *", all("reembed_wordpress"), { timezone: "UTC" });
  // Sitemap crawl kept as fallback weekly cross-check, Saturday 02:00 UTC
  cron.schedule("0 2 * * 6", all("crawl_link_map"), { timezone: "UTC" });
  // Daily 06:00 UTC — refresh the persistent keyword-movement Google Sheet
  // (GSC daily data through today-2 is settled by then).
  // 2 AM Pacific, NOT UTC: the sheet's day columns end at "yesterday Pacific
  // Time" (GSC buckets days in PT). The old 06:00 UTC slot fired at 10-11 PM
  // PT the *previous* day, so "yesterday PT" resolved two calendar days back
  // and the sheet perpetually lagged an extra day.
  cron.schedule("0 2 * * *", all("sync_keyword_sheet"), {
    timezone: "America/Los_Angeles",
  });
  // Friday 10:00 UTC — weekly digest (after Thursday's audits have refreshed signals)
  cron.schedule("0 10 * * 5", all("weekly_digest"), { timezone: "UTC" });
  // Daily 04:00 UTC — Bing Webmaster stats (free API, one key; full-window
  // delete+reinsert so daily cadence just keeps the rolling window fresh).
  cron.schedule("0 4 * * *", all("sync_bing_pages"), { timezone: "UTC" });
  // Hourly catch-up sweep: reruns any scheduled job whose last run exceeds
  // its cadence threshold (daily >26h, weekly >8d, monthly >33d), covering
  // servers that were asleep/recycled at the scheduled minute. Also fired
  // once on startup (index.ts). Cheap when nothing is overdue (one SELECT
  // per catch-up job per site).
  cron.schedule("17 * * * *", () => void runDailyCatchUp(), { timezone: "UTC" });
  logger.info(
    "Cron schedules registered (UTC: Sun02 WP crawl, Mon03 GSC, Tue06 semantic_linking, " +
      "Thu07/08/09 audits (orphans/over_linked/broken_links), Sat02 sitemap, monthly-01 reembed). " +
      "Jobs run per claimed site, sequentially. optimize_queued_urls is on-demand only — no cron.",
  );
}
