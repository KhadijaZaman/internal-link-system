import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  sitesTable,
  usersTable,
  jobRunsTable,
  trackedSubmissionsTable,
} from "@workspace/db";
import { registerJob, runJob, type JobName } from "./runner";
import { runDailyCatchUp } from "./scheduler";
import { runSyncBingPages } from "./syncBingPages";
import { runSyncGa4Pages } from "./syncGa4Pages";
import { runGscInventoryAndLosers } from "./gscInventory";
import { runSyncKeywordSheet } from "./syncKeywordSheet";
import { runCrawlWordpress } from "./crawlWordpress";
import type { SiteContext } from "../lib/site";

/**
 * Integration test (real Postgres via DATABASE_URL): a site whose data
 * source (Bing / GA4 / GSC) is NOT connected must be skipped quietly by the
 * per-site sync jobs —
 *
 * 1. Each sync job finishes with job_runs status "ok" (not "error"): the
 *    IntegrationNotConnectedError raised by the fetch stage is a
 *    configuration state, not a failure.
 * 2. The hourly catch-up sweep (runDailyCatchUp) treats that ok-skip as a
 *    real run: it does NOT re-run the job again within its staleness window
 *    (26h for daily jobs), so a disconnected site is never retried in a loop.
 *
 * The catch-up sweep normally iterates every claimed site; here
 * listSchedulableSites is mocked to return ONLY the test site so the sweep
 * can never trigger real jobs (or write job_runs rows) for real sites.
 */

// Only the test site is visible to the catch-up sweep in this process.
let testSites: SiteContext[] = [];
vi.mock("../lib/site", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/site")>();
  return {
    ...actual,
    listSchedulableSites: async () => testSites,
  };
});

const SYNC_JOBS: Array<{ name: JobName; fn: (site: SiteContext) => Promise<void> }> = [
  { name: "sync_bing_pages", fn: runSyncBingPages },
  { name: "sync_ga4_pages", fn: runSyncGa4Pages },
  { name: "gsc_inventory_and_losers", fn: runGscInventoryAndLosers },
  { name: "sync_keyword_sheet", fn: runSyncKeywordSheet },
  // The weekly content crawl skips quietly too: a site with no sitemapUrl
  // (never connected WordPress / a content source) raises
  // IntegrationNotConnectedError from the fetch stage, which the job treats
  // as a configuration state (status ok), not a failure.
  { name: "crawl_wordpress", fn: runCrawlWordpress },
];

const suffix = `${Date.now()}-${process.pid}`;
const USER = `user_test_skip_${suffix}`;
const HOST = `skip-${suffix}.test`;

let site: SiteContext;

async function jobRun(name: JobName) {
  const rows = await db
    .select()
    .from(jobRunsTable)
    .where(and(eq(jobRunsTable.name, name), eq(jobRunsTable.siteId, site.id)));
  return rows[0] ?? null;
}

beforeAll(async () => {
  await db.insert(usersTable).values([{ id: USER }]);
  const inserted = await db
    .insert(sitesTable)
    .values([
      {
        ownerUserId: USER,
        domain: HOST,
        host: HOST,
        displayName: "Skip Test Site",
      },
    ])
    .returning();
  site = inserted[0]!;
  testSites = [site];
  // A tracked keyword forces sync_keyword_sheet past its "no tracked
  // keywords" early exit and into the GSC fetch stage, so the job exercises
  // the IntegrationNotConnectedError skip path like the other three.
  await db.insert(trackedSubmissionsTable).values([
    { siteId: site.id, url: `https://${HOST}/page/`, keyword: "test keyword" },
  ]);
  for (const { name, fn } of SYNC_JOBS) registerJob(name, fn);
});

afterAll(async () => {
  if (site) {
    await db.delete(trackedSubmissionsTable).where(eq(trackedSubmissionsTable.siteId, site.id));
    await db.delete(jobRunsTable).where(eq(jobRunsTable.siteId, site.id));
    await db.delete(sitesTable).where(eq(sitesTable.id, site.id));
  }
  await db.delete(usersTable).where(inArray(usersTable.id, [USER]));
});

describe("sync jobs skip quietly when the data source is not connected", () => {
  it.each(SYNC_JOBS.map((j) => [j.name] as const))(
    "%s records job_runs status ok (not error)",
    async (name) => {
      const result = await runJob(name, site);
      expect(result.started).toBe(true);
      if (result.started) await result.completion;

      const run = await jobRun(name);
      if (!run) throw new Error(`missing job_runs row for ${name}`);
      expect(run.lastStatus).toBe("ok");
      expect(run.lastError).toBeNull();
    },
  );
});

describe("catch-up sweep after an ok-skip", () => {
  it("does not re-run a job that skipped within its staleness window", async () => {
    // Each sync job just ran (and skipped with status ok) moments ago.
    const before = new Map<JobName, Date>();
    for (const { name } of SYNC_JOBS) {
      const run = await jobRun(name);
      if (!run?.lastRunAt) throw new Error(`missing prior run for ${name}`);
      before.set(name, run.lastRunAt);
    }

    await runDailyCatchUp();

    // No job re-ran: lastRunAt is byte-identical to the pre-sweep value and
    // the status is still the ok recorded by the skip.
    for (const { name } of SYNC_JOBS) {
      const run = await jobRun(name);
      expect(run?.lastRunAt?.getTime()).toBe(before.get(name)!.getTime());
      expect(run?.lastStatus).toBe("ok");
    }
  });

  it("positive control: the same job IS re-run once older than 26h", async () => {
    // Backdate the daily sync_bing_pages run past the 26h daily threshold.
    const stale = new Date(Date.now() - 27 * 60 * 60 * 1000);
    await db
      .update(jobRunsTable)
      .set({ lastRunAt: stale })
      .where(
        and(eq(jobRunsTable.name, "sync_bing_pages"), eq(jobRunsTable.siteId, site.id)),
      );

    await runDailyCatchUp();

    const run = await jobRun("sync_bing_pages");
    if (!run?.lastRunAt) throw new Error("missing sync_bing_pages run");
    // The sweep re-ran the job (fresh timestamp) and the not-connected skip
    // again finished ok — no error row even on the retry path.
    expect(run.lastRunAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(run.lastStatus).toBe("ok");
    expect(run.lastError).toBeNull();
  });
});
