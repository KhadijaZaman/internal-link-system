import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, sitesTable, usersTable } from "@workspace/db";

/**
 * Cross-site isolation integration test (real Postgres via DATABASE_URL,
 * real Express app, Clerk mocked at the module boundary).
 *
 * Verifies the core multi-tenancy guarantees end to end:
 *  - GET /api/sites only lists the caller's own sites
 *  - a data route with someone else's X-Site-Id returns 403
 *  - PATCH /api/site (rename) and DELETE /api/site respect ownership
 *  - DELETE removes the site row (cascades handle the rest)
 *  - unauthenticated requests get 401
 */

// Clerk is replaced with a header-driven fake: the test sets `x-test-user`
// and getAuth reports that as the verified user id. Only the two symbols the
// server actually imports are mocked.
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

// Import AFTER the mock so app.ts picks up the fake clerkMiddleware.
const { default: app } = await import("../app");

const RUN = `${Date.now()}-${process.pid}`;
const USER_A = `test-user-a-${RUN}`;
const USER_B = `test-user-b-${RUN}`;

let siteA: number;
let siteB: number;

function asUser(userId: string) {
  return {
    get: (url: string) => request(app).get(url).set("x-test-user", userId),
    patch: (url: string) => request(app).patch(url).set("x-test-user", userId),
    delete: (url: string) => request(app).delete(url).set("x-test-user", userId),
  };
}

beforeAll(async () => {
  // requireAuth JIT-provisions users, but insert up front so the sites FK
  // is satisfied before any request runs.
  await db
    .insert(usersTable)
    .values([{ id: USER_A }, { id: USER_B }])
    .onConflictDoNothing({ target: usersTable.id });

  const rows = await db
    .insert(sitesTable)
    .values([
      {
        domain: `site-a-${RUN}.example.com`,
        host: `site-a-${RUN}.example.com`,
        displayName: `Site A ${RUN}`,
        ownerUserId: USER_A,
      },
      {
        domain: `site-b-${RUN}.example.com`,
        host: `site-b-${RUN}.example.com`,
        displayName: `Site B ${RUN}`,
        ownerUserId: USER_B,
      },
    ])
    .returning({ id: sitesTable.id, ownerUserId: sitesTable.ownerUserId });
  siteA = rows.find((r) => r.ownerUserId === USER_A)!.id;
  siteB = rows.find((r) => r.ownerUserId === USER_B)!.id;
});

afterAll(async () => {
  const ids = [siteA, siteB].filter((v): v is number => typeof v === "number");
  if (ids.length > 0) {
    await db.delete(sitesTable).where(inArray(sitesTable.id, ids));
  }
  await db.delete(usersTable).where(inArray(usersTable.id, [USER_A, USER_B]));
});

describe("authentication boundary", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/sites");
    expect(res.status).toBe(401);
  });
});

describe("site listing isolation", () => {
  it("GET /api/sites returns only the caller's sites", async () => {
    const resA = await asUser(USER_A).get("/api/sites");
    expect(resA.status).toBe(200);
    const idsA = (resA.body.sites as { id: number }[]).map((s) => s.id);
    expect(idsA).toContain(siteA);
    expect(idsA).not.toContain(siteB);

    const resB = await asUser(USER_B).get("/api/sites");
    expect(resB.status).toBe(200);
    const idsB = (resB.body.sites as { id: number }[]).map((s) => s.id);
    expect(idsB).toContain(siteB);
    expect(idsB).not.toContain(siteA);
  });
});

describe("X-Site-Id ownership enforcement", () => {
  it("allows a data route on the caller's own site", async () => {
    const res = await asUser(USER_A)
      .get("/api/site/limits")
      .set("x-site-id", String(siteA));
    expect(res.status).toBe(200);
    expect(res.body.limits).toBeDefined();
    expect(res.body.bounds).toBeDefined();
  });

  it("returns 403 for a data route on someone else's site", async () => {
    const res = await asUser(USER_A)
      .get("/api/site/limits")
      .set("x-site-id", String(siteB));
    expect(res.status).toBe(403);
  });

  it("returns 400 when X-Site-Id is missing", async () => {
    const res = await asUser(USER_A).get("/api/site/limits");
    expect(res.status).toBe(400);
  });
});

describe("rename ownership", () => {
  it("owner can rename their site", async () => {
    const res = await asUser(USER_A)
      .patch("/api/site")
      .set("x-site-id", String(siteA))
      .send({ displayName: `Renamed A ${RUN}` });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe(`Renamed A ${RUN}`);
  });

  it("non-owner cannot rename someone else's site", async () => {
    const res = await asUser(USER_A)
      .patch("/api/site")
      .set("x-site-id", String(siteB))
      .send({ displayName: "hijacked" });
    expect(res.status).toBe(403);
    const [row] = await db
      .select({ displayName: sitesTable.displayName })
      .from(sitesTable)
      .where(eq(sitesTable.id, siteB));
    expect(row.displayName).toBe(`Site B ${RUN}`);
  });
});

describe("delete ownership and cleanup", () => {
  it("non-owner cannot delete someone else's site", async () => {
    const res = await asUser(USER_A)
      .delete("/api/site")
      .set("x-site-id", String(siteB));
    expect(res.status).toBe(403);
    const rows = await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.id, siteB));
    expect(rows).toHaveLength(1);
  });

  it("owner can delete their own site (204) and the row is gone", async () => {
    const res = await asUser(USER_B)
      .delete("/api/site")
      .set("x-site-id", String(siteB));
    expect(res.status).toBe(204);

    const rows = await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.id, siteB));
    expect(rows).toHaveLength(0);

    // The other tenant is untouched.
    const resA = await asUser(USER_A).get("/api/sites");
    expect((resA.body.sites as { id: number }[]).map((s) => s.id)).toContain(siteA);
  });
});
