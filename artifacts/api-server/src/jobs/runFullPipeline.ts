import { runCrawlWordpress } from "./crawlWordpress";
import { runCrawlLinkMap } from "./crawlLinkMap";
import { runGscInventoryAndLosers } from "./gscInventory";
import { runSemanticLinking } from "./semanticLinking";
import { runAuditOrphans, runAuditOverLinked, runAuditBrokenLinks } from "./audits";
import { runOptimizeQueuedUrls } from "./optimizeUrls";
import { db, crawlProgressTable, jobRunsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";
import { LEGACY_SITE_ID } from "../lib/site";
import type { JobName } from "./runner";

type Step = { name: JobName; fn: () => Promise<void> };

async function recordJobRun(
  name: JobName,
  status: "ok" | "error",
  durationMs: number,
  err: string | null,
): Promise<void> {
  try {
    await withDbRetry(
      () =>
        db
          .insert(jobRunsTable)
          .values({
            name,
            siteId: LEGACY_SITE_ID,
            lastRunAt: new Date(),
            lastStatus: status,
            lastDurationMs: durationMs,
            lastError: err,
          })
          .onConflictDoUpdate({
            target: [jobRunsTable.name, jobRunsTable.siteId],
            set: {
              lastRunAt: new Date(),
              lastStatus: status,
              lastDurationMs: durationMs,
              lastError: err,
            },
          }),
      { label: `record_job_run:${name}` },
    );
  } catch (e) {
    logger.error({ err: e, jobName: name }, "Full pipeline: failed to record job run");
  }
}

const MAX_LINK_MAP_CHUNKS = 200;

async function runFullCrawlWordpress(): Promise<void> {
  await runCrawlWordpress({ reembedAll: true });
}

async function runFullCrawlLinkMap(): Promise<void> {
  await withDbRetry(
    () =>
      db
        .insert(crawlProgressTable)
        .values({ id: 1, siteId: LEGACY_SITE_ID, lastOffset: 0 })
        .onConflictDoUpdate({
          target: [crawlProgressTable.id, crawlProgressTable.siteId],
          set: { lastOffset: 0, lastRunAt: new Date() },
        }),
    { label: "crawl_link_map:reset_progress" },
  );
  for (let i = 0; i < MAX_LINK_MAP_CHUNKS; i++) {
    await runCrawlLinkMap();
    const progress = await withDbRetry(
      () =>
        db
          .select()
          .from(crawlProgressTable)
          .where(and(eq(crawlProgressTable.id, 1), eq(crawlProgressTable.siteId, LEGACY_SITE_ID)))
          .limit(1),
      { label: "crawl_link_map:read_progress" },
    );
    const off = progress[0]?.lastOffset ?? 0;
    logger.info({ iteration: i + 1, nextOffset: off }, "Full pipeline: link map chunk done");
    if (off === 0) return;
  }
  logger.warn(
    { maxChunks: MAX_LINK_MAP_CHUNKS },
    "Full pipeline: link map reached max chunk safety cap; stopping",
  );
}

const STEPS: Step[] = [
  { name: "crawl_wordpress", fn: runFullCrawlWordpress },
  { name: "crawl_link_map", fn: runFullCrawlLinkMap },
  { name: "gsc_inventory_and_losers", fn: runGscInventoryAndLosers },
  { name: "semantic_linking", fn: runSemanticLinking },
  { name: "audit_orphans", fn: runAuditOrphans },
  { name: "audit_over_linked", fn: runAuditOverLinked },
  { name: "audit_broken_links", fn: runAuditBrokenLinks },
  { name: "optimize_queued_urls", fn: runOptimizeQueuedUrls },
];

export async function runFullPipeline(): Promise<void> {
  logger.info({ steps: STEPS.length }, "Full pipeline: starting (forced full rerun)");
  const failures: Array<{ name: string; error: string }> = [];
  for (const step of STEPS) {
    const start = Date.now();
    try {
      logger.info({ step: step.name }, "Full pipeline: step start");
      await step.fn();
      const duration = Date.now() - start;
      logger.info({ step: step.name, durationMs: duration }, "Full pipeline: step ok");
      await recordJobRun(step.name, "ok", duration, null);
    } catch (err) {
      const duration = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ step: step.name, err }, "Full pipeline: step failed; continuing");
      await recordJobRun(step.name, "error", duration, msg);
      failures.push({ name: step.name, error: msg });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Full pipeline finished with ${failures.length} failed step(s): ${failures
        .map((f) => `${f.name} (${f.error})`)
        .join("; ")}`,
    );
  }
  logger.info("Full pipeline: all steps complete");
}
