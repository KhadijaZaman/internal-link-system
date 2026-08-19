/**
 * Route tests for the GSC-only clustering contract.
 *
 * Covers:
 *  - Normal GSC-only POST /clustering/runs succeeds without paidRunConfirmed or locationCode
 *  - Fractional keywordLimit is rejected (400) before any DB insert
 *  - Queued params have evidenceSource=gsc_page and algorithmVersion=1
 *  - POST /clustering/runs/{runId}/rebuild rejects a legacy run (no evidenceSource) with 409
 *  - GET /clustering/estimate returns 404 (route removed)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockDbSelect, mockDbUpdate, mockDbInsert, mockRunJob } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
  mockRunJob: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/site", () => ({
  requireSite: (_req: unknown, _res: unknown, next: () => void) => next(),
  getSite: () => ({ id: 1, host: "example.com", url: "https://example.com" }),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: mockDbInsert,
  },
  clusterRunsTable: {},
  clusterRunClustersTable: {},
}));

vi.mock("../jobs/runner", () => ({
  runJob: mockRunJob,
}));

vi.mock("../integrations/gsc", () => ({
  withCache: vi.fn(),
}));

vi.mock("../services/authoritySnapshot", () => ({
  buildCentroid: vi.fn(),
  ensureQueryEmbeddings: vi.fn(),
  DEFAULT_CORE_THRESHOLD: 0.42,
}));

vi.mock("../lib/semanticScorer", () => ({
  cosineSim: vi.fn(),
}));

vi.mock("../services/clustering", () => ({
  aggregateClusterPrior: vi.fn(),
  resolveRunWeeks: (body: { weeks?: unknown; days?: unknown }) => {
    if (body.weeks !== undefined) {
      return typeof body.weeks === "number" && Number.isInteger(body.weeks) ? body.weeks : null;
    }
    if (body.days !== undefined) {
      return typeof body.days === "number" && Number.isInteger(body.days) ? Math.ceil((body.days as number) / 7) : null;
    }
    return 12; // default
  },
}));

import clusteringRouter from "./clustering";

const app = express();
app.use(express.json());
app.use(clusteringRouter);

// ---------------------------------------------------------------------------
// DB chain helper — builds a fluent stub: .select().from().where().limit()
// ---------------------------------------------------------------------------
function makeDbSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockReturnThis(),
  };
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

function makeDbInsertChain(rows: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  mockDbInsert.mockReturnValue(chain);
  return chain;
}

function makeDbUpdateChain(rows: unknown[]) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  mockDbUpdate.mockReturnValue(chain);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GSC-only clustering routes", () => {
  beforeEach(() => {
    mockDbSelect.mockReset();
    mockDbUpdate.mockReset();
    mockDbInsert.mockReset();
    mockRunJob.mockReset();
  });

  it("accepts a normal GSC-only request without paidRunConfirmed or locationCode", async () => {
    // reconcileStaleRuns UPDATE
    makeDbUpdateChain([]);
    // active-run SELECT → none
    makeDbSelectChain([]);
    // INSERT run
    const insertedRun = {
      id: 42,
      siteId: 1,
      status: "queued",
      phase: null,
      params: { weeks: 12, country: null, keywordLimit: 250, excludeBrand: true, evidenceSource: "gsc_page", algorithmVersion: 1 },
      progressDone: 0,
      progressTotal: 0,
      stats: {},
      error: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      startedAt: null,
      finishedAt: null,
    };
    makeDbInsertChain([insertedRun]);
    mockRunJob.mockResolvedValue({ started: true });

    const response = await request(app)
      .post("/clustering/runs")
      .send({ keywordLimit: 250 });

    expect(response.status).toBe(202);
    expect(response.body.id).toBe(42);
    expect(response.body.status).toBe("queued");
  });

  it("rejects fractional keywordLimit before any DB insert", async () => {
    // reconcileStaleRuns UPDATE (may or may not be called depending on where guard fires)
    makeDbUpdateChain([]);

    const response = await request(app)
      .post("/clustering/runs")
      .send({ keywordLimit: 10.5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/integer/i);
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it("queued params have evidenceSource=gsc_page and algorithmVersion=1", async () => {
    // reconcileStaleRuns UPDATE
    makeDbUpdateChain([]);
    // active-run SELECT → none
    makeDbSelectChain([]);

    let capturedParams: Record<string, unknown> | null = null;
    // Capture what gets inserted
    const insertChain = {
      values: vi.fn().mockImplementation((row: { params: Record<string, unknown> }) => {
        capturedParams = row.params;
        return insertChain;
      }),
      returning: vi.fn().mockResolvedValue([{
        id: 1,
        siteId: 1,
        status: "queued",
        phase: null,
        params: { weeks: 12, country: null, keywordLimit: 250, excludeBrand: true, evidenceSource: "gsc_page", algorithmVersion: 1 },
        progressDone: 0,
        progressTotal: 0,
        stats: {},
        error: null,
        createdAt: new Date("2024-01-01T00:00:00Z"),
        startedAt: null,
        finishedAt: null,
      }]),
    };
    mockDbInsert.mockReturnValue(insertChain);
    mockRunJob.mockResolvedValue({ started: true });

    await request(app).post("/clustering/runs").send({ weeks: 12, keywordLimit: 250 });

    expect(capturedParams).not.toBeNull();
    expect(capturedParams!["evidenceSource"]).toBe("gsc_page");
    expect(capturedParams!["algorithmVersion"]).toBe(1);
    expect(capturedParams).not.toHaveProperty("locationCode");
  });

  it("rebuild rejects a legacy run (no evidenceSource) with 409 and GSC message", async () => {
    // reconcileStaleRuns UPDATE
    makeDbUpdateChain([]);
    // SELECT the run → legacy run (no evidenceSource)
    makeDbSelectChain([{
      id: 7,
      siteId: 1,
      status: "complete",
      phase: null,
      params: { weeks: 12, country: null, keywordLimit: 250, locationCode: 2840, excludeBrand: true },
      progressDone: 100,
      progressTotal: 100,
      stats: {},
      error: null,
      createdAt: new Date("2023-01-01T00:00:00Z"),
      startedAt: new Date("2023-01-01T00:01:00Z"),
      finishedAt: new Date("2023-01-01T01:00:00Z"),
    }]);

    const response = await request(app).post("/clustering/runs/7/rebuild").send();

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/gsc.only run/i);
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it("GET /clustering/estimate returns 404 (route removed)", async () => {
    const response = await request(app)
      .get("/clustering/estimate")
      .query({ keywordCount: 250 });

    expect(response.status).toBe(404);
  });
});
