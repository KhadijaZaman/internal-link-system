import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  appStateTable,
  backlinkProspectsTable,
  db,
  linkMapRunsTable,
  pagesTable,
  researchRunsTable,
  sitesTable,
  topicalMapsTable,
  usersTable,
  wpPostsTable,
} from "@workspace/db";
import { listSchedulableSites } from "../lib/site";
import {
  cleanupExpiredTopicClusterFixtures,
  E2E_FIXTURE_MAX_AGE_MS,
} from "./testingTopicClusterFixture";
import { deleteSiteData } from "../lib/deleteSiteData";

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
const STALE_OWNER = `test-topic-cluster-fixture-stale-${RUN}`;
const SHARED_OWNER = `test-topic-cluster-fixture-shared-${RUN}`;
const RESERVED_HOST_OWNER = `test-topic-cluster-fixture-reserved-host-${RUN}`;
const originalNodeEnv = process.env["NODE_ENV"];
let siteId: number | undefined;
const cleanupSiteIds = new Set<number>();

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
  if (siteId !== undefined) cleanupSiteIds.add(siteId);
  for (const id of cleanupSiteIds) {
    await deleteSiteData(id);
  }
  await db
    .delete(usersTable)
    .where(
      inArray(usersTable.id, [
        OWNER,
        OTHER_USER,
        STALE_OWNER,
        SHARED_OWNER,
        RESERVED_HOST_OWNER,
      ]),
    );
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

  it("removes only expired reserved fixtures and orphaned local fixture users", async () => {
    const old = new Date(Date.now() - E2E_FIXTURE_MAX_AGE_MS - 1_000);
    const staleResponse = await postFixture(STALE_OWNER);
    const sharedResponse = await postFixture(SHARED_OWNER);
    expect(staleResponse.status).toBe(201);
    expect(sharedResponse.status).toBe(201);
    const staleFixtureId = staleResponse.body.siteId as number;
    const staleMapId = staleResponse.body.mapId as number;
    const sharedFixtureId = sharedResponse.body.siteId as number;
    cleanupSiteIds.add(staleFixtureId);
    cleanupSiteIds.add(sharedFixtureId);
    await db
      .update(sitesTable)
      .set({ createdAt: old })
      .where(inArray(sitesTable.id, [staleFixtureId, sharedFixtureId]));
    await db.insert(backlinkProspectsTable).values({
      siteId: staleFixtureId,
      domain: "fixture-prospect.test",
    });
    await db.insert(linkMapRunsTable).values({
      siteId: staleFixtureId,
      centralEntity: "Synthetic Search Visibility",
      pageUrls: ["https://fixture.test/page"],
      model: "fixture-model",
    });
    await db.insert(researchRunsTable).values({ siteId: staleFixtureId });
    const staleStateKey = `link_map_sheet_id:${staleFixtureId}:shared`;
    await db
      .insert(appStateTable)
      .values({ key: staleStateKey, value: "fixture-sheet" });

    const [realSite] = await db
      .insert(sitesTable)
      .values({
        ownerUserId: SHARED_OWNER,
        domain: "https://a-real-user-site.test",
        host: `a-real-user-site-${RUN}.test`,
        displayName: "A real user site",
        createdAt: old,
      })
      .returning();
    cleanupSiteIds.add(realSite!.id);
    await db.insert(usersTable).values({ id: RESERVED_HOST_OWNER });
    const [reservedHostSite] = await db
      .insert(sitesTable)
      .values({
        ownerUserId: RESERVED_HOST_OWNER,
        domain: `https://not-a-browser-fixture-${RUN}.e2e-fixture.test`,
        host: `not-a-browser-fixture-${RUN}.e2e-fixture.test`,
        displayName: "Reserved-host non-fixture site",
        createdAt: old,
      })
      .returning();
    cleanupSiteIds.add(reservedHostSite!.id);

    process.env["NODE_ENV"] = "production";
    expect(await cleanupExpiredTopicClusterFixtures()).toBe(0);
    process.env["NODE_ENV"] = "development";
    expect(
      await db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, staleFixtureId)),
    ).toHaveLength(1);
    expect(await cleanupExpiredTopicClusterFixtures()).toBe(2);
    expect(
      await db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, staleFixtureId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.siteId, staleFixtureId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(topicalMapsTable)
        .where(eq(topicalMapsTable.id, staleMapId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(backlinkProspectsTable)
        .where(eq(backlinkProspectsTable.siteId, staleFixtureId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(linkMapRunsTable)
        .where(eq(linkMapRunsTable.siteId, staleFixtureId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(researchRunsTable)
        .where(eq(researchRunsTable.siteId, staleFixtureId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(appStateTable)
        .where(eq(appStateTable.key, staleStateKey)),
    ).toHaveLength(0);
    expect(
      await db.select().from(usersTable).where(eq(usersTable.id, STALE_OWNER)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, sharedFixtureId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(sitesTable).where(eq(sitesTable.id, realSite!.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(usersTable).where(eq(usersTable.id, SHARED_OWNER)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, reservedHostSite!.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, RESERVED_HOST_OWNER)),
    ).toHaveLength(1);

    const recreated = await postFixture(STALE_OWNER);
    expect(recreated.status).toBe(201);
    expect(recreated.body.siteId).not.toBe(staleFixtureId);
    cleanupSiteIds.add(recreated.body.siteId as number);
    expect(
      await db.select().from(usersTable).where(eq(usersTable.id, STALE_OWNER)),
    ).toHaveLength(1);
  });
});
