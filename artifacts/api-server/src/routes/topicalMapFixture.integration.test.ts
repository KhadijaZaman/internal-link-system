import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pagesTable,
  sitesTable,
  topicalMapsTable,
  usersTable,
  wpPostsTable,
} from "@workspace/db";
import { listSchedulableSites } from "../lib/site";

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user"];
    const userId = Array.isArray(raw) ? raw[0] : raw;
    return { userId: userId ?? null };
  },
}));

const { default: app } = await import("../app");

const RUN = `${Date.now()}-${process.pid}`;
const OWNER = `test-topic-cluster-fixture-owner-${RUN}`;
const OTHER_USER = `test-topic-cluster-fixture-other-${RUN}`;
const originalNodeEnv = process.env["NODE_ENV"];
let siteId: number | undefined;

function postFixture(userId = OWNER) {
  return request(app)
    .post("/api/testing/topic-clusters/fixture")
    .set("x-test-user", userId);
}

beforeAll(() => {
  process.env["NODE_ENV"] = "development";
});

afterAll(async () => {
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
  if (siteId !== undefined) {
    await db.delete(topicalMapsTable).where(eq(topicalMapsTable.siteId, siteId));
    await db.delete(wpPostsTable).where(eq(wpPostsTable.siteId, siteId));
    await db.delete(pagesTable).where(eq(pagesTable.siteId, siteId));
    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  }
  await db.delete(usersTable).where(inArray(usersTable.id, [OWNER, OTHER_USER]));
});

describe("topic-cluster browser fixture", () => {
  it("is owner-scoped, reusable, job-free, and serves the full similar-page list", async () => {
    const first = await postFixture();
    expect(first.status).toBe(201);
    expect(first.body.host).toMatch(/\.e2e-fixture\.test$/);
    siteId = first.body.siteId as number;

    const second = await postFixture();
    expect(second.status).toBe(201);
    expect(second.body.siteId).toBe(siteId);
    expect(second.body.mapId).not.toBe(first.body.mapId);

    const detail = await request(app)
      .get(`/api/topical-map/runs/${second.body.mapId}`)
      .set("x-test-user", OWNER)
      .set("x-site-id", String(siteId));
    expect(detail.status).toBe(200);
    expect(detail.body.map.status).toBe("complete");
    expect(detail.body.map.centralEntity).toBe("Synthetic Search Visibility");
    expect(detail.body.coverage.perPillar).toHaveLength(1);

    const similarPages = detail.body.coverage.perPillar[0].similarPages as Array<{
      path: string;
      similarity: number;
    }>;
    expect(similarPages).toHaveLength(4);
    expect(similarPages.map((page) => page.path)).toEqual([
      "/fixture/anchor",
      "/fixture/related",
      "/fixture/more",
      "/fixture/threshold",
    ]);
    expect(similarPages.map((page) => page.similarity)).toEqual([1, 0.91, 0.76, 0.42]);

    const denied = await request(app)
      .get(`/api/topical-map/runs/${second.body.mapId}`)
      .set("x-test-user", OTHER_USER)
      .set("x-site-id", String(siteId));
    expect(denied.status).toBe(403);

    const schedulableIds = new Set(
      (await listSchedulableSites()).map((site) => site.id),
    );
    expect(schedulableIds).not.toContain(siteId);
  });

  it("is unavailable outside development", async () => {
    process.env["NODE_ENV"] = "production";
    let response: Awaited<ReturnType<typeof postFixture>>;
    try {
      response = await postFixture();
    } finally {
      process.env["NODE_ENV"] = "development";
    }
    expect(response.status).toBe(404);
  });
});