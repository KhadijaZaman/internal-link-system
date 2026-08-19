import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { mockDbUpdate, mockDbInsert, mockRunJob } = vi.hoisted(() => ({
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
  resolveRunWeeks: (body: { weeks?: unknown }) =>
    typeof body.weeks === "number" && Number.isInteger(body.weeks) ? body.weeks : null,
}));

import clusteringRouter from "./clustering";

const app = express();
app.use(express.json());
app.use(clusteringRouter);

describe("paid clustering confirmation", () => {
  beforeEach(() => {
    mockDbUpdate.mockReset();
    mockDbInsert.mockReset();
    mockRunJob.mockReset();
  });

  it.each([
    ["missing", { weeks: 4, keywordLimit: 10 }],
    ["false", { weeks: 4, keywordLimit: 10, paidRunConfirmed: false }],
  ])("rejects %s approval before creating a run", async (_label, body) => {
    const response = await request(app).post("/clustering/runs").send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/confirm|invalid|required/i);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockRunJob).not.toHaveBeenCalled();
  });
});