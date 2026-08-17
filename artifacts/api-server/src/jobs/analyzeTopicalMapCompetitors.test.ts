/**
 * Unit tests for analyzeTopicalMapCompetitors / scanOneMap.
 *
 * Scenarios covered:
 *  1. Budget cap → un-scanned nodes prioritised; status → 'partial'.
 *  2. Repeat scan: previously-scanned nodes are processed last; newly-un-scanned
 *     nodes are processed first even when their alphabetical order would be later.
 *  3. Task-level DataForSEO 'failed' responses are counted and included in the
 *     partial-coverage note; status → 'partial'.
 *  4. Full coverage (all tasks succeed, no budget trim) → status → 'complete'.
 *  5. Budget exhausted (remaining === 0) → throws so the caller marks 'failed'.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/dbRetry", () => ({
  withDbRetry: async (fn: () => unknown) => fn(),
}));

// We need the drizzle helpers to work like no-ops so the mock DB chain resolves.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, val: unknown) => ({ _eq: val }),
  isNull: (_col: unknown) => ({ _isNull: true }),
  sql: Object.assign((s: TemplateStringsArray, ..._vals: unknown[]) => ({ _sql: s.join("?") }), {
    raw: (s: string) => ({ _raw: s }),
  }),
}));

// Capture all db.update().set().where() calls per table.
const statusUpdates: Array<{ table: string; fields: Record<string, unknown> }> = [];
const nodeUpdates: Array<{ nodeId: unknown; competitors: unknown }> = [];

/** Minimal drizzle chain that records writes. */
function makeWriteChain(tableName: string) {
  const chain = {
    _fields: {} as Record<string, unknown>,
    set(f: Record<string, unknown>) {
      this._fields = f;
      return this;
    },
    where(_cond: unknown) {
      if (tableName === "topical_maps") {
        statusUpdates.push({ table: tableName, fields: this._fields });
      } else if (tableName === "topical_map_nodes") {
        // Extract nodeId from the eq condition chain (we stored it as { _eq: val }).
        const eqArr = _cond as Array<{ _eq?: unknown }>;
        const nodeIdCond = Array.isArray(eqArr) ? eqArr[1] : null;
        nodeUpdates.push({ nodeId: nodeIdCond?._eq, competitors: this._fields["competitors"] });
      }
      return { returning: () => Promise.resolve([this._fields]) };
    },
  };
  return chain;
}

// Node rows returned by the DB select.
let mockNodes: Array<{ id: number; canonicalQuery: string; competitors: unknown }> = [];

const selectChain = {
  from(_table: unknown) {
    return this;
  },
  where(_cond: unknown) {
    return Promise.resolve(mockNodes);
  },
};

vi.mock("@workspace/db", () => ({
  db: {
    select: (_cols?: unknown) => selectChain,
    update: (table: unknown) => {
      // Identify which table by checking the object reference.
      const isNodeTable =
        (table as Record<string, unknown>)["_tableName"] === "topical_map_nodes";
      return makeWriteChain(isNodeTable ? "topical_map_nodes" : "topical_maps");
    },
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
  topicalMapsTable: { _tableName: "topical_maps", id: "id", siteId: "siteId", competitorScanStatus: "competitorScanStatus" },
  topicalMapNodesTable: { _tableName: "topical_map_nodes", id: "id", siteId: "siteId", mapId: "mapId", canonicalQuery: "canonicalQuery", competitors: "competitors" },
}));

// DataForSEO mocks — overridden per test.
let mockPostSerpTasks: MockInstance;
let mockFetchSerpTaskResult: MockInstance;

vi.mock("../integrations/dataforseo", () => ({
  postSerpTasks: vi.fn(),
  fetchSerpTaskResult: vi.fn(),
}));

// Budget mock — controlled per test.
let mockRemaining = 1000;
const mockTake = vi.fn().mockReturnValue(true);
vi.mock("../lib/jobBudget", () => ({
  budgetForSite: () => ({
    remaining: (_kind: string) => mockRemaining,
    take: mockTake,
  }),
}));

// ── Test subject ────────────────────────────────────────────────────────────────

import { scanOneMap, COMPETITOR_SCAN_HEARTBEAT_MS } from "./analyzeTopicalMapCompetitors";
import * as dfsModule from "../integrations/dataforseo";

// ── Shared fixtures ─────────────────────────────────────────────────────────────

function makeMap(id = 1) {
  return {
    id,
    siteId: 99,
    status: "complete",
    competitorScanStatus: "running",
    competitorScanStartedAt: new Date(),
    competitorScanError: null,
  } as Parameters<typeof scanOneMap>[0];
}

function makeSite() {
  return {
    id: 99,
    host: "mysite.com",
    url: "https://mysite.com",
    protocol: "https" as const,
    domain: "mysite.com",
    displayName: "My Site",
    sitemapUrl: null,
    ownerUserId: "user-1",
    maxLlmCallsPerRun: 10,
    maxSerpQueriesPerRun: 100,
    maxCrawlPages: 500,
  };
}

/** A SERP result with one competitor URL for the given query. */
function okResult(keyword: string, domain: string) {
  return { status: "ok" as const, keyword, urls: [{ url: `https://${domain}/page`, position: 1 }] };
}

beforeEach(() => {
  statusUpdates.length = 0;
  nodeUpdates.length = 0;
  mockRemaining = 1000;
  mockTake.mockClear();
  vi.useFakeTimers();

  mockPostSerpTasks = vi.mocked(dfsModule.postSerpTasks);
  mockFetchSerpTaskResult = vi.mocked(dfsModule.fetchSerpTaskResult);
  mockPostSerpTasks.mockReset();
  mockFetchSerpTaskResult.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Run scanOneMap, advancing all timers so sleep() calls resolve immediately.
 * A no-op rejection handler is attached immediately to prevent Node.js from
 * surfacing an "unhandledRejection" event during the timer-advancement await
 * when the scan is expected to throw.
 */
async function runScan(map = makeMap(), site = makeSite()): Promise<void> {
  const promise = scanOneMap(
    map as Parameters<typeof scanOneMap>[0],
    site as Parameters<typeof scanOneMap>[1],
  );
  // Suppress the unhandled-rejection window during timer advancement.
  promise.catch(() => {});
  // Advance past SERP_INITIAL_WAIT_MS and any SERP_SWEEP_INTERVAL_MS ticks.
  await vi.runAllTimersAsync();
  return promise; // propagates any rejection to the caller (e.g. expect().rejects)
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("analyzeTopicalMapCompetitors – scanOneMap", () => {
  // ── 1. Budget cap → partial, un-scanned nodes prioritised ────────────────────
  describe("budget cap behaviour", () => {
    it("marks status 'partial' when budget cap trims un-scanned queries", async () => {
      // Map has 3 unique queries, but budget only allows 2.
      mockNodes = [
        { id: 1, canonicalQuery: "alpha", competitors: null },
        { id: 2, canonicalQuery: "beta",  competitors: null },
        { id: 3, canonicalQuery: "gamma", competitors: null },
      ];
      mockRemaining = 2; // only 2 SERP calls allowed

      mockPostSerpTasks.mockResolvedValue(["task-1", "task-2"]);
      mockFetchSerpTaskResult
        .mockResolvedValueOnce(okResult("alpha", "competitor1.com"))
        .mockResolvedValueOnce(okResult("beta", "competitor2.com"));

      await runScan();

      // Status should be 'partial' because one un-scanned query was trimmed.
      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("partial");
      expect(finalStatus?.fields["competitorScanError"]).toContain("un-scanned topic");
    });

    it("sends only the budget-allowed number of queries to DataForSEO", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "query-a", competitors: null },
        { id: 2, canonicalQuery: "query-b", competitors: null },
        { id: 3, canonicalQuery: "query-c", competitors: null },
      ];
      mockRemaining = 2;

      mockPostSerpTasks.mockResolvedValue(["t1", "t2"]);
      mockFetchSerpTaskResult
        .mockResolvedValueOnce(okResult("query-a", "c1.com"))
        .mockResolvedValueOnce(okResult("query-b", "c2.com"));

      await runScan();

      expect(mockPostSerpTasks).toHaveBeenCalledWith(
        expect.arrayContaining(["query-a", "query-b"]),
        expect.any(Number),
      );
      // Third query must not be sent.
      const [sentQueries] = mockPostSerpTasks.mock.calls[0] as [string[], number];
      expect(sentQueries).toHaveLength(2);
      expect(sentQueries).not.toContain("query-c");
    });

    it("throws (→ 'failed') when remaining budget is 0", async () => {
      mockNodes = [{ id: 1, canonicalQuery: "anything", competitors: null }];
      mockRemaining = 0;

      await expect(runScan()).rejects.toThrow(/quota cap reached/i);
    });
  });

  // ── 2. Repeat scan: un-scanned nodes processed first ────────────────────────
  describe("repeat scan prioritisation", () => {
    it("processes un-scanned queries before already-scanned ones under budget cap", async () => {
      // Node 1 already has competitors; node 2 does not.
      // With budget = 1, only one query can be fetched — it must be the un-scanned one.
      mockNodes = [
        {
          id: 1,
          canonicalQuery: "already-scanned",
          competitors: [{ domain: "old.com", url: "https://old.com/", bestPosition: 3, matchedQuery: "already-scanned" }],
        },
        { id: 2, canonicalQuery: "new-topic", competitors: null },
      ];
      mockRemaining = 1;

      mockPostSerpTasks.mockResolvedValue(["task-x"]);
      mockFetchSerpTaskResult.mockResolvedValueOnce(okResult("new-topic", "fresh.com"));

      await runScan();

      // Only "new-topic" must have been sent.
      const [sentQueries] = mockPostSerpTasks.mock.calls[0] as [string[], number];
      expect(sentQueries).toEqual(["new-topic"]);

      // The already-scanned node must NOT have been overwritten (no nodeUpdate for id=1).
      const node1Update = nodeUpdates.find((u) => u.nodeId === 1);
      expect(node1Update).toBeUndefined();

      // Node 2 should now have competitors stored.
      const node2Update = nodeUpdates.find((u) => u.nodeId === 2);
      expect(node2Update).toBeDefined();
    });

    it("marks 'complete' when all topics were already-scanned and re-fetched successfully", async () => {
      mockNodes = [
        {
          id: 1,
          canonicalQuery: "topic-a",
          competitors: [{ domain: "prev.com", url: "https://prev.com/", bestPosition: 2, matchedQuery: "topic-a" }],
        },
      ];
      mockRemaining = 10; // budget allows re-fetching

      mockPostSerpTasks.mockResolvedValue(["t1"]);
      mockFetchSerpTaskResult.mockResolvedValueOnce(okResult("topic-a", "new.com"));

      await runScan();

      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      // No un-scanned queries were skipped → complete.
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("complete");
    });
  });

  // ── 3. Task-level DataForSEO 'failed' responses ──────────────────────────────
  describe("DataForSEO task-level failures", () => {
    it("counts failed tasks in partial-coverage note and marks status 'partial'", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "keyword-ok", competitors: null },
        { id: 2, canonicalQuery: "keyword-fail", competitors: null },
      ];
      mockRemaining = 10;

      mockPostSerpTasks.mockResolvedValue(["task-ok", "task-fail"]);
      mockFetchSerpTaskResult
        .mockImplementation(async (taskId: string) => {
          if (taskId === "task-ok") return okResult("keyword-ok", "winner.com");
          return { status: "failed" as const, message: "DataForSEO internal error" };
        });

      await runScan();

      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("partial");
      expect(finalStatus?.fields["competitorScanError"]).toContain("DataForSEO error");
    });

    it("still stores results for tasks that succeeded even when others fail", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "good", competitors: null },
        { id: 2, canonicalQuery: "bad",  competitors: null },
      ];
      mockRemaining = 10;

      mockPostSerpTasks.mockResolvedValue(["t-good", "t-bad"]);
      mockFetchSerpTaskResult.mockImplementation(async (taskId: string) => {
        if (taskId === "t-good") return okResult("good", "good-competitor.com");
        return { status: "failed" as const, message: "API error" };
      });

      await runScan();

      // Node 1 (good query) should have competitors stored.
      const node1Update = nodeUpdates.find((u) => u.nodeId === 1);
      expect(node1Update?.competitors).toEqual(
        expect.arrayContaining([expect.objectContaining({ domain: "good-competitor.com" })]),
      );

      // Node 2 (failed query) should NOT have been touched.
      const node2Update = nodeUpdates.find((u) => u.nodeId === 2);
      expect(node2Update).toBeUndefined();
    });
  });

  // ── 4. Full coverage → 'complete' ────────────────────────────────────────────
  describe("full coverage", () => {
    it("marks status 'complete' when all queries are fetched and succeed", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "topic-one", competitors: null },
        { id: 2, canonicalQuery: "topic-two", competitors: null },
      ];
      mockRemaining = 10;

      mockPostSerpTasks.mockResolvedValue(["t1", "t2"]);
      mockFetchSerpTaskResult
        .mockImplementation(async (taskId: string) => {
          const kw = taskId === "t1" ? "topic-one" : "topic-two";
          return okResult(kw, "top-result.com");
        });

      await runScan();

      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("complete");
      expect(finalStatus?.fields["competitorScanError"]).toBeNull();
    });

    it("filters out the site's own domain from competitor results", async () => {
      mockNodes = [{ id: 1, canonicalQuery: "branded", competitors: null }];
      mockRemaining = 5;

      mockPostSerpTasks.mockResolvedValue(["t1"]);
      // Result contains own domain and one external competitor.
      mockFetchSerpTaskResult.mockResolvedValueOnce({
        status: "ok" as const,
        keyword: "branded",
        urls: [
          { url: "https://mysite.com/page", position: 1 },
          { url: "https://competitor.com/page", position: 2 },
        ],
      });

      await runScan();

      const update = nodeUpdates.find((u) => u.nodeId === 1);
      expect(update?.competitors).toEqual(
        expect.arrayContaining([expect.objectContaining({ domain: "competitor.com" })]),
      );
      // Own site must be excluded.
      const competitors = update?.competitors as Array<{ domain: string }> ?? [];
      expect(competitors.some((c) => c.domain.includes("mysite"))).toBe(false);
    });
  });

  // ── 5. Partial task_post acceptance ─────────────────────────────────────────
  describe("partial task_post acceptance", () => {
    it("marks 'partial' when DataForSEO rejects some tasks at submission time", async () => {
      // 3 queries submitted but DataForSEO only accepts 2.
      mockNodes = [
        { id: 1, canonicalQuery: "q-accepted-1", competitors: null },
        { id: 2, canonicalQuery: "q-accepted-2", competitors: null },
        { id: 3, canonicalQuery: "q-rejected",   competitors: null },
      ];
      mockRemaining = 10;

      // Only 2 task IDs returned even though 3 were submitted.
      mockPostSerpTasks.mockResolvedValue(["t1", "t2"]);
      mockFetchSerpTaskResult
        .mockImplementation(async (taskId: string) => {
          const kw = taskId === "t1" ? "q-accepted-1" : "q-accepted-2";
          return okResult(kw, "winner.com");
        });

      await runScan();

      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("partial");
      expect(finalStatus?.fields["competitorScanError"]).toMatch(/rejected by DataForSEO/i);
    });

    it("does not overwrite existing competitor data for the rejected query's node", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "accepted", competitors: null },
        {
          id: 2,
          canonicalQuery: "rejected",
          competitors: [{ domain: "old.com", url: "https://old.com/", bestPosition: 5, matchedQuery: "rejected" }],
        },
      ];
      mockRemaining = 10;

      // DataForSEO rejects the second task.
      mockPostSerpTasks.mockResolvedValue(["only-t1"]);
      mockFetchSerpTaskResult.mockResolvedValueOnce(okResult("accepted", "new.com"));

      await runScan();

      // Node 2 (rejected query) must NOT have been touched.
      const node2Update = nodeUpdates.find((u) => u.nodeId === 2);
      expect(node2Update).toBeUndefined();
    });
  });

  // ── 6. Thrown fetchSerpTaskResult (poll transport failure) ───────────────────
  describe("poll transport failures (thrown fetchSerpTaskResult)", () => {
    it("marks 'partial' when fetchSerpTaskResult throws for a task", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "fine",   competitors: null },
        { id: 2, canonicalQuery: "broken", competitors: null },
      ];
      mockRemaining = 10;

      mockPostSerpTasks.mockResolvedValue(["t-fine", "t-broken"]);
      mockFetchSerpTaskResult.mockImplementation(async (taskId: string) => {
        if (taskId === "t-fine") return okResult("fine", "ok-site.com");
        throw new Error("Network error");
      });

      await runScan();

      const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
      expect(finalStatus?.fields["competitorScanStatus"]).toBe("partial");
      expect(finalStatus?.fields["competitorScanError"]).toMatch(/could not be retrieved/i);
    });

    it("still stores results for tasks that polled successfully", async () => {
      mockNodes = [
        { id: 1, canonicalQuery: "ok",  competitors: null },
        { id: 2, canonicalQuery: "err", competitors: null },
      ];
      mockRemaining = 10;

      mockPostSerpTasks.mockResolvedValue(["t-ok", "t-err"]);
      mockFetchSerpTaskResult.mockImplementation(async (taskId: string) => {
        if (taskId === "t-ok") return okResult("ok", "good.com");
        throw new Error("transport error");
      });

      await runScan();

      const node1Update = nodeUpdates.find((u) => u.nodeId === 1);
      expect(node1Update?.competitors).toEqual(
        expect.arrayContaining([expect.objectContaining({ domain: "good.com" })]),
      );
      // Node 2 must not have been written.
      expect(nodeUpdates.find((u) => u.nodeId === 2)).toBeUndefined();
    });
  });

  // ── 7. Empty map ─────────────────────────────────────────────────────────────
  it("marks 'complete' immediately when the map has no nodes", async () => {
    mockNodes = [];
    mockRemaining = 100;

    await runScan();

    expect(mockPostSerpTasks).not.toHaveBeenCalled();
    const finalStatus = statusUpdates.find((u) => u.fields["competitorScanStatus"]);
    expect(finalStatus?.fields["competitorScanStatus"]).toBe("complete");
  });
});
