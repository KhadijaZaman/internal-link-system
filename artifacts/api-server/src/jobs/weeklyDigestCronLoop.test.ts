import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the per-site cron loop that drives weekly_digest.
 *
 * runJobForAllSites iterates every claimed site sequentially. An email send
 * failure for one site (bad recipient, mailer quota, broken template) must be
 * logged and isolated — it must not abort the remaining sites. These tests
 * verify that guarantee at the unit level (no real DB, no real mailer) by
 * mocking the two collaborators that the loop depends on: listSchedulableSites
 * and runJob.
 *
 * The integration-level isolation proof (real Postgres, full runner) lives in
 * schedulerIsolation.integration.test.ts. These tests exist so that a future
 * refactor of the cron loop cannot accidentally break the error boundary
 * without a fast, DB-free test catching it.
 */

// ── mock runJob so no real job code or DB is touched ─────────────────────────
const runJobMock = vi.fn();
vi.mock("./runner", () => ({
  registerJob: vi.fn(),
  runJob: (...args: unknown[]) => (runJobMock as (...a: unknown[]) => unknown)(...args),
  lastRunAt: vi.fn(),
  ALL_JOBS: [],
}));

// ── mock site listing ─────────────────────────────────────────────────────────
const listSchedulableSitesMock = vi.fn();
vi.mock("../lib/site", () => ({
  listSchedulableSites: () => listSchedulableSitesMock(),
}));

// ── capture logger calls to assert on error reporting ────────────────────────
const loggerErrorMock = vi.fn();
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => (loggerErrorMock as (...a: unknown[]) => void)(...args),
    debug: vi.fn(),
  },
}));

import { runJobForAllSites } from "./scheduler";

const fakeSites = [
  { id: 1, host: "site-one.example" },
  { id: 2, host: "site-two.example" },
  { id: 3, host: "site-three.example" },
] as Parameters<typeof runJobForAllSites>[0] extends infer _
  ? Array<{ id: number; host: string }>
  : never;

beforeEach(() => {
  vi.clearAllMocks();
  listSchedulableSitesMock.mockResolvedValue(fakeSites);
});

describe("weekly_digest cron loop — per-site error isolation", () => {
  it("continues to remaining sites when one site's completion rejects with an email send error", async () => {
    // Site 2 simulates a digest email failure (e.g. bad recipient address,
    // mailer quota exceeded, broken template). The completion promise rejects —
    // this is the path the defensive catch in runJobForAllSites is designed to
    // absorb.
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 2) {
        return {
          started: true,
          completion: Promise.reject(new Error("SMTP: recipient address rejected")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("weekly_digest");

    // All three sites were attempted.
    const calledSiteIds = runJobMock.mock.calls.map(
      ([_name, site]: [string, { id: number }]) => site.id,
    );
    expect(calledSiteIds).toEqual([1, 2, 3]);
  });

  it("logs the failure for the failing site with siteId context", async () => {
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 2) {
        return {
          started: true,
          completion: Promise.reject(new Error("SMTP: recipient address rejected")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("weekly_digest");

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    const [meta, message] = loggerErrorMock.mock.calls[0]!;
    // The logged context must identify which site failed.
    expect(meta).toMatchObject({ siteId: 2, jobName: "weekly_digest" });
    expect(typeof message).toBe("string");
  });

  it("does not propagate the error — runJobForAllSites always resolves", async () => {
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 1) {
        return {
          started: true,
          completion: Promise.reject(new Error("mailer quota exhausted")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    // Must resolve, never reject, even when a site throws.
    await expect(runJobForAllSites("weekly_digest")).resolves.toBeUndefined();
  });

  it("runs subsequent sites even when the first site fails", async () => {
    const calledSiteIds: number[] = [];
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      calledSiteIds.push(site.id);
      if (site.id === 1) {
        return {
          started: true,
          completion: Promise.reject(new Error("forced first-site digest email failure")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("weekly_digest");

    // Sites 2 and 3 ran AFTER site 1 failed.
    expect(calledSiteIds).toContain(2);
    expect(calledSiteIds).toContain(3);
    expect(calledSiteIds.indexOf(1)).toBeLessThan(calledSiteIds.indexOf(2));
    expect(calledSiteIds.indexOf(2)).toBeLessThan(calledSiteIds.indexOf(3));
  });

  it("runs all sites successfully when no site throws", async () => {
    runJobMock.mockResolvedValue({ started: true, completion: Promise.resolve() });

    await runJobForAllSites("weekly_digest");

    expect(runJobMock).toHaveBeenCalledTimes(3);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("does not log an error when a site's digest job resolves immediately (subscriber-skip path)", async () => {
    // Site 2 simulates the no-subscriber case: runWeeklyDigest detects no
    // owner and returns without doing any work — the completion promise still
    // resolves cleanly, so the cron loop must treat it as a quiet success,
    // not an error.
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      // All sites resolve — site 2 just resolves immediately (subscriber skip).
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("weekly_digest");

    expect(loggerErrorMock).not.toHaveBeenCalled();
    // All three sites were still attempted; the skip does not abort the loop.
    expect(runJobMock).toHaveBeenCalledTimes(3);
  });

  it("processes all remaining sites after a no-subscriber site resolves quietly", async () => {
    const calledSiteIds: number[] = [];
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      calledSiteIds.push(site.id);
      // Site 2 is the no-subscriber site: job starts, completion resolves
      // immediately because runWeeklyDigest returned early.
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("weekly_digest");

    expect(calledSiteIds).toEqual([1, 2, 3]);
    // Sites 1 and 3 (with owners) ran after the no-subscriber site 2.
    expect(calledSiteIds.indexOf(2)).toBeLessThan(calledSiteIds.indexOf(3));
  });

  it("handles the case where runJob itself throws (defensive catch path)", async () => {
    // runJob itself throwing (not the completion) is the outer defensive case —
    // e.g. the template renderer crashes before an email is even attempted.
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 2) {
        throw new Error("runner internal crash");
      }
      return { started: true, completion: Promise.resolve() };
    });

    await expect(runJobForAllSites("weekly_digest")).resolves.toBeUndefined();

    const calledSiteIds = runJobMock.mock.calls.map(
      ([_name, site]: [string, { id: number }]) => site.id,
    );
    expect(calledSiteIds).toEqual([1, 2, 3]);
    expect(loggerErrorMock).toHaveBeenCalledOnce();
    expect(loggerErrorMock.mock.calls[0]![0]).toMatchObject({ siteId: 2 });
  });
});
