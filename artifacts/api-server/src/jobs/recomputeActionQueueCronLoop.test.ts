import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the per-site cron loop that drives recompute_action_queue.
 *
 * runJobForAllSites iterates every claimed site sequentially. A DB error for
 * one site must be logged and isolated — it must not abort the remaining sites.
 * These tests verify that guarantee at the unit level (no real DB, no real
 * action-queue logic) by mocking the two collaborators that the loop depends
 * on: listSchedulableSites and runJob.
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

describe("recompute_action_queue cron loop — site-list query failure", () => {
  it("resolves without throwing when listSchedulableSites itself rejects", async () => {
    listSchedulableSitesMock.mockRejectedValue(new Error("DB unavailable at sweep start"));

    // Must resolve, never reject, even when the site-list query fails entirely.
    await expect(runJobForAllSites("recompute_action_queue")).resolves.toBeUndefined();
  });

  it("does not attempt to run any site job when listSchedulableSites rejects", async () => {
    listSchedulableSitesMock.mockRejectedValue(new Error("connection refused"));

    await runJobForAllSites("recompute_action_queue");

    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("logs the site-list failure with the job name in context", async () => {
    const cause = new Error("DB unavailable at sweep start");
    listSchedulableSitesMock.mockRejectedValue(cause);

    await runJobForAllSites("recompute_action_queue");

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    const [meta, message] = loggerErrorMock.mock.calls[0]!;
    expect(meta).toMatchObject({ err: cause, jobName: "recompute_action_queue" });
    expect(typeof message).toBe("string");
  });

  it("no unhandled rejection escapes when listSchedulableSites rejects", async () => {
    listSchedulableSitesMock.mockRejectedValue(new Error("connection refused"));

    // Collect any unhandled rejections that Node emits during this tick.
    const unhandled: Error[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on("unhandledRejection", handler);

    await runJobForAllSites("recompute_action_queue");

    // Drain the microtask queue so any leaked rejections have a chance to fire.
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", handler);

    expect(unhandled).toHaveLength(0);
  });
});

describe("recompute_action_queue cron loop — per-site error isolation", () => {
  it("continues to remaining sites when one site's completion rejects with a DB error", async () => {
    // Site 2 simulates a SQL failure (e.g. connection dropped, constraint violation).
    // The completion promise rejects — this is the path the defensive catch in
    // runJobForAllSites is designed to absorb.
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 2) {
        return {
          started: true,
          completion: Promise.reject(new Error("connection terminated unexpectedly")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("recompute_action_queue");

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
          completion: Promise.reject(new Error("connection terminated unexpectedly")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("recompute_action_queue");

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    const [meta, message] = loggerErrorMock.mock.calls[0]!;
    // The logged context must identify which site failed.
    expect(meta).toMatchObject({ siteId: 2, jobName: "recompute_action_queue" });
    expect(typeof message).toBe("string");
  });

  it("does not propagate the error — runJobForAllSites always resolves", async () => {
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 1) {
        return {
          started: true,
          completion: Promise.reject(new Error("SQL syntax error")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    // Must resolve, never reject, even when a site throws.
    await expect(runJobForAllSites("recompute_action_queue")).resolves.toBeUndefined();
  });

  it("runs subsequent sites even when the first site fails", async () => {
    const calledSiteIds: number[] = [];
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      calledSiteIds.push(site.id);
      if (site.id === 1) {
        return {
          started: true,
          completion: Promise.reject(new Error("forced first-site DB failure")),
        };
      }
      return { started: true, completion: Promise.resolve() };
    });

    await runJobForAllSites("recompute_action_queue");

    // Sites 2 and 3 ran AFTER site 1 failed.
    expect(calledSiteIds).toContain(2);
    expect(calledSiteIds).toContain(3);
    expect(calledSiteIds.indexOf(1)).toBeLessThan(calledSiteIds.indexOf(2));
    expect(calledSiteIds.indexOf(2)).toBeLessThan(calledSiteIds.indexOf(3));
  });

  it("runs all sites successfully when no site throws", async () => {
    runJobMock.mockResolvedValue({ started: true, completion: Promise.resolve() });

    await runJobForAllSites("recompute_action_queue");

    expect(runJobMock).toHaveBeenCalledTimes(3);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("handles the case where runJob itself throws (defensive catch path)", async () => {
    // runJob itself throwing (not the completion) is the outer defensive case.
    runJobMock.mockImplementation(async (_name: string, site: { id: number }) => {
      if (site.id === 2) {
        throw new Error("runner internal crash");
      }
      return { started: true, completion: Promise.resolve() };
    });

    await expect(runJobForAllSites("recompute_action_queue")).resolves.toBeUndefined();

    const calledSiteIds = runJobMock.mock.calls.map(
      ([_name, site]: [string, { id: number }]) => site.id,
    );
    expect(calledSiteIds).toEqual([1, 2, 3]);
    expect(loggerErrorMock).toHaveBeenCalledOnce();
    expect(loggerErrorMock.mock.calls[0]![0]).toMatchObject({ siteId: 2 });
  });
});
