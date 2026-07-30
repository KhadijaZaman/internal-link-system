import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the hourly catch-up sweep (runDailyCatchUp) locking in:
 * - stale jobs re-run, fresh jobs don't (daily 26h / weekly 8d / monthly 33d)
 * - weekly/monthly jobs that have NEVER run are skipped (new-site guard),
 *   while never-run daily jobs still run same-day
 * - GSC inventory always runs before GA4 rollups (data dependency)
 * - spend-only on-demand jobs are never part of the sweep, even when they
 *   have no run history at all
 *
 * runner + site listing are stubbed so no DB or real job code is touched.
 */

const runJobMock = vi.fn(async (_name: string, _site: { id: number }) => ({
  started: true as const,
  completion: Promise.resolve(),
}));
const lastRunAtMock = vi.fn(async (_name: string, _siteId: number): Promise<Date | null> => null);

vi.mock("./runner", () => ({
  registerJob: vi.fn(),
  runJob: (name: string, site: { id: number }) => runJobMock(name, site),
  lastRunAt: (name: string, siteId: number) => lastRunAtMock(name, siteId),
  ALL_JOBS: [],
}));

const SITE = { id: 1 };
vi.mock("../lib/site", () => ({
  listSchedulableSites: async () => [SITE],
}));

import { runDailyCatchUp } from "./scheduler";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const agesMs = new Map<string, number | null>(); // null = never ran

function setAges(entries: Record<string, number | null>): void {
  agesMs.clear();
  for (const [k, v] of Object.entries(entries)) agesMs.set(k, v);
}

const SPEND_ONLY_JOBS = [
  "optimize_queued_urls",
  "keyword_clustering",
  "analyze_similarity",
  "generate_topical_map",
];

const DAILY_JOBS = ["sync_keyword_sheet", "sync_bing_pages"];
const WEEKLY_JOBS = [
  "crawl_wordpress",
  "gsc_inventory_and_losers",
  "sync_ga4_pages",
  "semantic_linking",
  "audit_orphans",
  "audit_over_linked",
  "audit_broken_links",
  "crawl_link_map",
  "weekly_digest",
];
const MONTHLY_JOBS = ["reembed_wordpress"];

beforeEach(() => {
  runJobMock.mockClear();
  lastRunAtMock.mockClear();
  // Default: everything ran recently (1h ago) → nothing is overdue.
  agesMs.clear();
  lastRunAtMock.mockImplementation(async (name) => {
    const age = agesMs.has(name) ? agesMs.get(name)! : HOUR;
    return age === null ? null : new Date(Date.now() - age);
  });
});

function ranJobs(): string[] {
  return runJobMock.mock.calls.map(([name]) => name);
}

describe("runDailyCatchUp", () => {
  it("runs stale jobs and skips fresh ones at each cadence threshold", async () => {
    setAges({
      // daily: threshold 26h
      sync_keyword_sheet: 30 * HOUR, // stale → run
      sync_bing_pages: 20 * HOUR, // fresh → skip
      // weekly: threshold 8d
      audit_orphans: 9 * DAY, // stale → run
      semantic_linking: 6 * DAY, // fresh → skip
      // monthly: threshold 33d
      reembed_wordpress: 35 * DAY, // stale → run
    });
    await runDailyCatchUp();
    const ran = ranJobs();
    expect(ran).toContain("sync_keyword_sheet");
    expect(ran).not.toContain("sync_bing_pages");
    expect(ran).toContain("audit_orphans");
    expect(ran).not.toContain("semantic_linking");
    expect(ran).toContain("reembed_wordpress");
  });

  it("skips never-run weekly/monthly jobs but runs never-run daily jobs", async () => {
    const never: Record<string, number | null> = {};
    for (const j of [...DAILY_JOBS, ...WEEKLY_JOBS, ...MONTHLY_JOBS]) never[j] = null;
    setAges(never);
    await runDailyCatchUp();
    const ran = ranJobs();
    // Daily jobs run even with no history (new site wants them same-day).
    for (const j of DAILY_JOBS) expect(ran).toContain(j);
    // Weekly + monthly never-run jobs are left to their regular cron.
    for (const j of [...WEEKLY_JOBS, ...MONTHLY_JOBS]) expect(ran).not.toContain(j);
  });

  it("runs GSC inventory before GA4 rollups when both are overdue", async () => {
    setAges({
      gsc_inventory_and_losers: 9 * DAY,
      sync_ga4_pages: 9 * DAY,
    });
    await runDailyCatchUp();
    const ran = ranJobs();
    const gsc = ran.indexOf("gsc_inventory_and_losers");
    const ga4 = ran.indexOf("sync_ga4_pages");
    expect(gsc).toBeGreaterThanOrEqual(0);
    expect(ga4).toBeGreaterThanOrEqual(0);
    expect(gsc).toBeLessThan(ga4);
  });

  it("never includes spend-only on-demand jobs, even with no run history", async () => {
    // Make EVERY job maximally overdue: no history at all.
    lastRunAtMock.mockImplementation(async () => null);
    await runDailyCatchUp();
    const ran = ranJobs();
    for (const j of SPEND_ONLY_JOBS) expect(ran).not.toContain(j);

    // And even with ancient (1-year-old) run history they stay excluded.
    runJobMock.mockClear();
    lastRunAtMock.mockImplementation(async () => new Date(Date.now() - 365 * DAY));
    await runDailyCatchUp();
    for (const j of SPEND_ONLY_JOBS) expect(ranJobs()).not.toContain(j);
  });

  it("does not double-run: exactly one runJob call per overdue (job, site)", async () => {
    setAges({ sync_keyword_sheet: 30 * HOUR });
    await runDailyCatchUp();
    const calls = runJobMock.mock.calls.filter(([n]) => n === "sync_keyword_sheet");
    expect(calls.length).toBe(1);
    expect(calls[0]![1]).toBe(SITE);
  });
});
