import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guardrail tests for startScheduler()'s regular cron schedule.
 *
 * Spend-sensitive on-demand jobs (optimize_queued_urls, keyword_clustering,
 * analyze_similarity, generate_topical_map) must NEVER be attached to a
 * cron — they cost OpenAI/DataForSEO money and may only run on an explicit
 * user trigger. These tests stub node-cron, call startScheduler(), invoke
 * every registered cron callback, and assert:
 * - no cron callback runs a spend-only job
 * - the set of cron-scheduled jobs matches the documented weekly/daily/
 *   monthly cadence exactly (accidental removals are caught too)
 *
 * runner + site listing are stubbed so no DB or real job code is touched
 * (same pattern as catchUpSweep.test.ts).
 */

const scheduleMock = vi.fn(
  (_expr: string, _fn: () => void, _opts?: unknown) => ({ stop: vi.fn() }),
);
vi.mock("node-cron", () => ({
  default: { schedule: (...args: unknown[]) => (scheduleMock as any)(...args) },
}));

const runJobMock = vi.fn(async (_name: string, _site: { id: number }) => ({
  started: true as const,
  completion: Promise.resolve(),
}));
// Everything "ran recently" so the hourly catch-up callback is a no-op and
// contributes no job names of its own.
const lastRunAtMock = vi.fn(async () => new Date());

vi.mock("./runner", () => ({
  registerJob: vi.fn(),
  runJob: (name: string, site: { id: number }) => runJobMock(name, site),
  lastRunAt: () => lastRunAtMock(),
  ALL_JOBS: [],
}));

vi.mock("../lib/site", () => ({
  listSchedulableSites: async () => [{ id: 1 }],
}));

import { startScheduler } from "./scheduler";

const SPEND_ONLY_JOBS = [
  "optimize_queued_urls",
  "keyword_clustering",
  "analyze_similarity",
  "generate_topical_map",
];

// Documented cadence: cron expression → job it must run (the hourly
// "17 * * * *" catch-up sweep runs no job directly when nothing is overdue).
const EXPECTED_SCHEDULE: Record<string, string | null> = {
  "0 2 * * 0": "crawl_wordpress", // Sunday 02:00 UTC
  "0 3 * * 1": "gsc_inventory_and_losers", // Monday 03:00 UTC
  "30 3 * * 1": "sync_ga4_pages", // Monday 03:30 UTC (after GSC)
  "0 6 * * 2": "semantic_linking", // Tuesday 06:00 UTC
  "0 7 * * 4": "audit_orphans", // Thursday 07:00 UTC
  "0 8 * * 4": "audit_over_linked", // Thursday 08:00 UTC
  "0 9 * * 4": "audit_broken_links", // Thursday 09:00 UTC
  "*/10 * * * *": "embed_kb_chunks", // 10-min KB embed sweep
  "0 1 1 * *": "reembed_wordpress", // Monthly, 1st 01:00 UTC
  "0 2 * * 6": "crawl_link_map", // Saturday 02:00 UTC
  "0 2 * * *": "sync_keyword_sheet", // Daily 02:00 America/Los_Angeles
  "0 10 * * 5": "weekly_digest", // Friday 10:00 UTC
  "0 4 * * *": "sync_bing_pages", // Daily 04:00 UTC
  "17 * * * *": null, // hourly catch-up sweep
};

/** Let the fire-and-forget `void runJobForAllSites(...)` chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Invoke one registered cron callback and return the job names it ran. */
async function jobsRunBy(cb: () => void): Promise<string[]> {
  runJobMock.mockClear();
  cb();
  await flush();
  return runJobMock.mock.calls.map(([name]) => name);
}

beforeEach(() => {
  scheduleMock.mockClear();
  runJobMock.mockClear();
});

describe("startScheduler cron schedule", () => {
  it("never puts a spend-only on-demand job on any cron", async () => {
    startScheduler();
    expect(scheduleMock.mock.calls.length).toBeGreaterThan(0);
    for (const [expr, cb] of scheduleMock.mock.calls) {
      const ran = await jobsRunBy(cb as () => void);
      for (const j of SPEND_ONLY_JOBS) {
        expect(ran, `cron "${expr}" must not run spend-only job ${j}`).not.toContain(j);
      }
    }
  });

  it("registers exactly the documented weekly/daily/monthly schedule", async () => {
    startScheduler();
    const seen: Record<string, string | null> = {};
    for (const [expr, cb] of scheduleMock.mock.calls) {
      const ran = await jobsRunBy(cb as () => void);
      expect(ran.length, `cron "${expr}" should run at most one job`).toBeLessThanOrEqual(1);
      expect(seen, `duplicate cron expression "${expr}"`).not.toHaveProperty(expr as string);
      seen[expr as string] = ran[0] ?? null;
    }
    expect(seen).toEqual(EXPECTED_SCHEDULE);
  });
});
