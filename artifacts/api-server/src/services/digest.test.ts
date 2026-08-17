import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the runWeeklyDigest service — specifically the no-subscriber
 * skip path.
 *
 * When a site has no owner (ownerUserId === null) there is nobody to receive
 * the weekly digest. The job must:
 *   - return early without touching the database
 *   - log an informational skip message (NOT an error)
 *   - resolve cleanly so the cron loop can continue to the next site
 *
 * A site with an owner present must still go through the normal
 * compute-and-upsert path; this verifies the early-return is conditional, not
 * unconditional.
 *
 * No real DB or mailer is used — @workspace/db is mocked with a chainable
 * proxy so every Drizzle query builder chain resolves to an empty row set,
 * and the upsert is recorded via a mock spy.
 */

// ── logger capture ───────────────────────────────────────────────────────────
const loggerInfoMock = vi.fn();
const loggerErrorMock = vi.fn();
vi.mock("../lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => (loggerInfoMock as (...a: unknown[]) => void)(...args),
    warn: vi.fn(),
    error: (...args: unknown[]) => (loggerErrorMock as (...a: unknown[]) => void)(...args),
    debug: vi.fn(),
  },
}));

// ── chainable Drizzle query-builder mock ─────────────────────────────────────
// Drizzle query builders are "thenable" — awaiting them executes the query.
// This proxy makes every chained method return itself so the builder chain
// (select → from → where → orderBy → limit) resolves to `rows` when awaited.
// Promise methods (then/catch/finally) must be bound to the underlying Promise
// so that their `this` is correct — using them via the Proxy without binding
// throws "Method Promise.prototype.then called on incompatible receiver".
function makeQueryChain(rows: unknown[] = []): unknown {
  const p = Promise.resolve(rows);
  return new Proxy(p as object, {
    get(_target, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        // Bind to the underlying Promise so `this` is correct inside the
        // native Promise method — without this the Proxy receiver causes
        // "Method Promise.prototype.then called on incompatible receiver".
        return (p as Promise<unknown[]>)[prop as "then" | "catch" | "finally"].bind(p);
      }
      // Any unknown chained call (from, where, orderBy, limit …) returns
      // the same thenable so the whole chain eventually resolves to `rows`.
      return () => makeQueryChain(rows);
    },
  });
}

const dbSelectMock = vi.fn(() => makeQueryChain([]));
const dbInsertMock = vi.fn();
const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => dbSelectMock(),
    insert: () => dbInsertMock(),
  },
  actionItemsTable: {},
  digestsTable: { siteId: "site_id", weekOf: "week_of" },
  healthSnapshotsTable: {},
}));

// ── dbRetry pass-through ─────────────────────────────────────────────────────
vi.mock("../lib/dbRetry", () => ({
  withDbRetry: (fn: () => Promise<unknown>) => fn(),
}));

// ── impact computation stub ──────────────────────────────────────────────────
vi.mock("./impact", () => ({
  computeImpactWins: vi.fn().mockResolvedValue({
    items: [],
    summary: { improved: 0, measuring: 0, flat: 0, declined: 0 },
  }),
}));

import { runWeeklyDigest } from "./digest";

// ── fixtures ─────────────────────────────────────────────────────────────────
const baseSite = {
  domain: "example.com",
  host: "example.com",
  displayName: "Example",
  sitemapUrl: null,
  maxCrawlPages: 2000,
  maxLlmCallsPerRun: 500,
  maxSerpQueriesPerRun: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockReturnValue(makeQueryChain([]));
  dbInsertMock.mockReturnValue({ values: valuesMock });
});

// ── no-subscriber skip ────────────────────────────────────────────────────────
describe("runWeeklyDigest — no-subscriber skip (ownerUserId is null)", () => {
  it("returns early without making any DB select calls", async () => {
    await runWeeklyDigest({ ...baseSite, id: 1, ownerUserId: null });

    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it("returns early without making any DB insert/upsert calls", async () => {
    await runWeeklyDigest({ ...baseSite, id: 1, ownerUserId: null });

    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("does not log an error for the no-subscriber site", async () => {
    await runWeeklyDigest({ ...baseSite, id: 1, ownerUserId: null });

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("logs an informational skip message identifying the site", async () => {
    await runWeeklyDigest({ ...baseSite, id: 7, ownerUserId: null });

    expect(loggerInfoMock).toHaveBeenCalledOnce();
    const [meta] = loggerInfoMock.mock.calls[0]!;
    expect(meta).toMatchObject({ siteId: 7 });
  });

  it("resolves cleanly — never rejects — so the cron loop can continue", async () => {
    await expect(
      runWeeklyDigest({ ...baseSite, id: 1, ownerUserId: null }),
    ).resolves.toBeUndefined();
  });
});

// ── other sites still receive their digest ────────────────────────────────────
describe("runWeeklyDigest — no-subscriber site does not affect other sites", () => {
  it("skips the no-subscriber site then processes the next site without error", async () => {
    const noOwner = { ...baseSite, id: 2, ownerUserId: null };
    const withOwner = { ...baseSite, id: 3, ownerUserId: "user_abc" };

    // Process the no-subscriber site first.
    await runWeeklyDigest(noOwner);
    const selectCallsAfterSkip = dbSelectMock.mock.calls.length;

    // Process a site that has a real owner.
    await runWeeklyDigest(withOwner);
    const selectCallsAfterBoth = dbSelectMock.mock.calls.length;

    // The no-subscriber site made zero DB calls; the owned site made DB calls.
    expect(selectCallsAfterSkip).toBe(0);
    expect(selectCallsAfterBoth).toBeGreaterThan(0);
  });

  it("logs no error for either site when one skips and one runs normally", async () => {
    const noOwner = { ...baseSite, id: 2, ownerUserId: null };
    const withOwner = { ...baseSite, id: 3, ownerUserId: "user_abc" };

    await runWeeklyDigest(noOwner);
    await runWeeklyDigest(withOwner);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("upserts a digest row for the site that has an owner", async () => {
    await runWeeklyDigest({ ...baseSite, id: 3, ownerUserId: "user_abc" });

    expect(dbInsertMock).toHaveBeenCalledOnce();
    expect(valuesMock).toHaveBeenCalledOnce();
    expect(onConflictDoUpdateMock).toHaveBeenCalledOnce();
  });
});
