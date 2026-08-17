import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the daily catch-up sweep (runDailyCatchUp).
 *
 * runDailyCatchUp begins by fetching every schedulable site. If that query
 * throws, the function must log the error and return cleanly — no unhandled
 * rejection, no attempt to run per-site jobs.
 *
 * These tests verify that guarantee at the unit level (no real DB, no real
 * job logic) by mocking the same two collaborators the existing
 * recomputeActionQueueCronLoop tests mock: listSchedulableSites and runJob.
 */

// ── mock runJob / lastRunAt so no real job code or DB is touched ──────────────
const runJobMock = vi.fn();
const lastRunAtMock = vi.fn();
vi.mock("./runner", () => ({
  registerJob: vi.fn(),
  runJob: (...args: unknown[]) => (runJobMock as (...a: unknown[]) => unknown)(...args),
  lastRunAt: (...args: unknown[]) =>
    (lastRunAtMock as (...a: unknown[]) => unknown)(...args),
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
    error: (...args: unknown[]) =>
      (loggerErrorMock as (...a: unknown[]) => void)(...args),
    debug: vi.fn(),
  },
}));

import { runDailyCatchUp } from "./scheduler";

const fakeSites = [
  { id: 1, host: "site-one.example" },
  { id: 2, host: "site-two.example" },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: healthy site list, lastRunAt returns null (overdue), runJob no-ops.
  listSchedulableSitesMock.mockResolvedValue(fakeSites);
  lastRunAtMock.mockResolvedValue(null);
  runJobMock.mockResolvedValue({ started: false, reason: "lock held" });
});

describe("runDailyCatchUp — site-list query failure", () => {
  it("resolves without throwing when listSchedulableSites rejects", async () => {
    listSchedulableSitesMock.mockRejectedValue(
      new Error("DB unavailable at sweep start"),
    );

    // Must resolve, never reject, even when the site-list query fails entirely.
    await expect(runDailyCatchUp()).resolves.toBeUndefined();
  });

  it("does not attempt to run any per-site job when listSchedulableSites rejects", async () => {
    listSchedulableSitesMock.mockRejectedValue(new Error("connection refused"));

    await runDailyCatchUp();

    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("logs the site-list failure with error context", async () => {
    const cause = new Error("DB unavailable at sweep start");
    listSchedulableSitesMock.mockRejectedValue(cause);

    await runDailyCatchUp();

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    const [meta, message] = loggerErrorMock.mock.calls[0]!;
    expect(meta).toMatchObject({ err: cause });
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

    await runDailyCatchUp();

    // Drain the microtask queue so any leaked rejections have a chance to fire.
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", handler);

    expect(unhandled).toHaveLength(0);
  });
});
