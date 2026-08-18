import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, sitesTable, usersTable, backlinkAuditsTable } from "@workspace/db";

/**
 * Integration tests for POST /api/backlinks/audit.
 *
 * Uses a real Postgres database with isolated test users and a temporary site,
 * a Clerk mock driven by the `x-test-user` header, and a DataForSEO integration
 * mock so no paid API calls are made.
 *
 * Verifies:
 *  1. GET /api/backlinks/audit returns null when no audit exists.
 *  2. POST runs all four legs and persists an own_profile row + competitor row.
 *  3. Re-running within 24 h returns the cached audit without re-fetching.
 *  4. POST with refresh:true re-fetches even though the cache is fresh.
 *  5. Posting with a new competitor list removes the stale competitor row.
 */

// ─── Clerk mock ───────────────────────────────────────────────────────────────

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

// ─── DataForSEO mock ──────────────────────────────────────────────────────────
// All four integration functions are mocked so no real HTTP calls are made.
// The mock factory returns incrementing fetched-at timestamps so force-refresh
// calls can be distinguished from cache hits.

let callCount = 0;

vi.mock("../integrations/dataforseo", () => {
  const summaryForTarget = (target: string) => ({
    target,
    rank: 400 + callCount++,
    backlinks: 38000 + callCount,
    referringDomains: 2100 + callCount,
    referringMainDomains: 1800,
    brokenBacklinks: 5,
    referringIps: 1200,
    dofollow: 21000,
    nofollow: 17000,
    firstSeen: "2020-01-01",
  });

  return {
    fetchBacklinkSummary: vi.fn((target: string) =>
      Promise.resolve(summaryForTarget(target)),
    ),
    fetchBacklinkAnchors: vi.fn(() =>
      Promise.resolve([
        { anchor: "", backlinks: 12000, referringDomains: 800, dofollow: 8000, nofollow: 4000 },
        { anchor: "Wellows", backlinks: 3000, referringDomains: 400, dofollow: 2500, nofollow: 500 },
      ]),
    ),
    fetchTopBacklinks: vi.fn(() =>
      Promise.resolve([
        {
          urlFrom: "https://github.com/example",
          urlTo: "https://wellows.com/",
          domainFrom: "github.com",
          pageFromTitle: "Example repo",
          anchor: "Wellows",
          dofollow: true,
          rank: 800,
          domainFromRank: 870,
          firstSeen: "2022-06-01",
          lastSeen: "2024-01-01",
        },
      ]),
    ),
    // Low-rank batch: a domain absent from the high-rank sample, carrying a
    // spam anchor so the anchor-spam scorer can flag it.
    fetchLowRankBacklinks: vi.fn(() =>
      Promise.resolve([
        {
          urlFrom: "https://cheap-pills-review.xyz/wellows",
          urlTo: "https://wellows.com/",
          domainFrom: "cheap-pills-review.xyz",
          pageFromTitle: "Best cheap pills",
          anchor: "online casino",
          dofollow: true,
          rank: 2,
          domainFromRank: 3,
          firstSeen: "2023-01-01",
          lastSeen: "2024-01-01",
        },
      ]),
    ),
    mergeBacklinkBatches: vi.fn(
      (highRank: unknown[], lowRank: unknown[]) => [...lowRank, ...highRank],
    ),
    fetchTopReferringDomains: vi.fn(() =>
      Promise.resolve([
        { domain: "allaboutai.com", backlinks: 14000, rank: 405, firstSeen: "2022-01-01", lastSeen: null },
        { domain: "gptdemo.net", backlinks: 6000, rank: 0, firstSeen: null, lastSeen: null },
      ]),
    ),
    isDataForSeoOutOfFunds: vi.fn(() => false),
  };
});

// ─── Test fixtures ────────────────────────────────────────────────────────────

// Import app AFTER mocks are registered so the route layer picks up the fakes.
const { default: app } = await import("../app");

const RUN = `${Date.now()}-${process.pid}`;
const USER = `test-backlink-audit-user-${RUN}`;

let siteId: number;
let siteHost: string;

function asUser() {
  const base = request(app);
  return {
    get: (url: string) =>
      base.get(url).set("x-test-user", USER).set("x-site-id", String(siteId)),
    post: (url: string) =>
      base.post(url).set("x-test-user", USER).set("x-site-id", String(siteId)),
  };
}

beforeAll(async () => {
  siteHost = `audit-test-${RUN}.example.com`;

  await db
    .insert(usersTable)
    .values({ id: USER })
    .onConflictDoNothing({ target: usersTable.id });

  const [row] = await db
    .insert(sitesTable)
    .values({
      domain: `https://${siteHost}/`,
      host: siteHost,
      displayName: `Audit Test ${RUN}`,
      ownerUserId: USER,
    })
    .returning({ id: sitesTable.id });

  siteId = row!.id;
});

afterAll(async () => {
  // Deleting the site cascades to backlink_audits rows via FK.
  await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  await db.delete(usersTable).where(inArray(usersTable.id, [USER]));
});

// Helper: clear audit rows for this test site between cases.
async function clearAudit() {
  await db
    .delete(backlinkAuditsTable)
    .where(eq(backlinkAuditsTable.siteId, siteId));
}

async function auditRows() {
  return db
    .select({
      kind: backlinkAuditsTable.kind,
      target: backlinkAuditsTable.target,
      fetchedAt: backlinkAuditsTable.fetchedAt,
      payload: backlinkAuditsTable.payload,
    })
    .from(backlinkAuditsTable)
    .where(eq(backlinkAuditsTable.siteId, siteId));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/backlinks/audit — initial state", () => {
  it("returns audit: null when no audit has been run", async () => {
    await clearAudit();
    const res = await asUser().get("/api/backlinks/audit");
    expect(res.status).toBe(200);
    expect(res.body.audit).toBeNull();
  });
});

describe("POST /api/backlinks/audit — first run", () => {
  beforeAll(() => clearAudit());

  it("returns 200 with all sections populated and persists rows", async () => {
    const res = await asUser()
      .post("/api/backlinks/audit")
      .send({ competitors: ["surferseo.com"] });

    expect(res.status).toBe(200);
    const { audit } = res.body;

    // Summary section.
    expect(audit.summary).not.toBeNull();
    expect(audit.summary.backlinks).toBeGreaterThan(0);
    expect(typeof audit.summary.rank).toBe("number");
    expect(typeof audit.summary.referringDomains).toBe("number");
    expect(typeof audit.summary.dofollow).toBe("number");
    expect(typeof audit.summary.nofollow).toBe("number");

    // Null-anchor bucket must be in the anchors list.
    expect(Array.isArray(audit.anchors)).toBe(true);
    expect(audit.anchors.length).toBeGreaterThan(0);
    const emptyAnchor = audit.anchors.find((a: { anchor: string }) => a.anchor === "");
    expect(emptyAnchor).toBeDefined();

    // Top backlinks — merged from high-rank and low-rank batches.
    expect(Array.isArray(audit.topBacklinks)).toBe(true);
    expect(audit.topBacklinks.length).toBeGreaterThan(0);
    expect(audit.topBacklinks[0]).toMatchObject({
      urlFrom: expect.any(String),
      domainFrom: expect.any(String),
      dofollow: expect.any(Boolean),
    });

    // The low-rank domain must be present in the merged topBacklinks so the
    // anchor-spam scorer can evaluate it (it would be absent from a high-rank-
    // only sample).
    const lowRankEntry = audit.topBacklinks.find(
      (bl: { domainFrom: string }) => bl.domainFrom === "cheap-pills-review.xyz",
    );
    expect(lowRankEntry).toBeDefined();
    expect(lowRankEntry).toMatchObject({
      anchor: "online casino",
      domainFromRank: 3,
    });

    // Referring domains.
    expect(Array.isArray(audit.referringDomains)).toBe(true);
    expect(audit.referringDomains.length).toBeGreaterThan(0);

    // Competitor benchmark.
    expect(Array.isArray(audit.competitors)).toBe(true);
    expect(audit.competitors).toHaveLength(1);
    expect(audit.competitors[0].target).toBe("surferseo.com");

    // DB persistence: expect 2 rows — own_profile + competitor_summary.
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["competitor_summary", "own_profile"]);

    const ownRow = rows.find((r) => r.kind === "own_profile")!;
    const payload = ownRow.payload as {
      summary: object; anchors: unknown[]; topBacklinks: unknown[]; referringDomains: unknown[];
    };
    expect(payload.summary).toBeDefined();
    expect(Array.isArray(payload.anchors)).toBe(true);
    expect(Array.isArray(payload.topBacklinks)).toBe(true);
    expect(Array.isArray(payload.referringDomains)).toBe(true);
  });
});

describe("POST /api/backlinks/audit — 24 h caching (no extra spend)", () => {
  it("returns cached data on a second call without triggering more DataForSEO fetches", async () => {
    // Rows already exist from the previous describe block.
    const rowsBefore = await auditRows();
    expect(rowsBefore.length).toBeGreaterThan(0);
    const fetchedAtBefore = rowsBefore
      .find((r) => r.kind === "own_profile")!
      .fetchedAt.toISOString();

    // Re-run without refresh — should be a cache hit.
    const res = await asUser()
      .post("/api/backlinks/audit")
      .send({ competitors: ["surferseo.com"] });

    expect(res.status).toBe(200);
    const rowsAfter = await auditRows();
    const fetchedAtAfter = rowsAfter
      .find((r) => r.kind === "own_profile")!
      .fetchedAt.toISOString();

    // fetchedAt must not have advanced — the row was served from cache.
    expect(fetchedAtAfter).toBe(fetchedAtBefore);
  });
});

describe("POST /api/backlinks/audit — force refresh", () => {
  it("re-fetches the own-profile row and advances fetchedAt", async () => {
    const rowsBefore = await auditRows();
    const fetchedAtBefore = rowsBefore
      .find((r) => r.kind === "own_profile")!
      .fetchedAt.getTime();

    // Give at least 1 ms so the timestamp differs.
    await new Promise((r) => setTimeout(r, 5));

    const res = await asUser()
      .post("/api/backlinks/audit")
      .send({ competitors: ["surferseo.com"], refresh: true });

    expect(res.status).toBe(200);

    const rowsAfter = await auditRows();
    const fetchedAtAfter = rowsAfter
      .find((r) => r.kind === "own_profile")!
      .fetchedAt.getTime();

    expect(fetchedAtAfter).toBeGreaterThan(fetchedAtBefore);
  });
});

describe("POST /api/backlinks/audit — dropping a competitor removes its row", () => {
  it("replaces the benchmark set when a new competitor list is submitted", async () => {
    // Existing state: surferseo.com competitor from previous blocks.
    const before = await auditRows();
    expect(before.find((r) => r.target === "surferseo.com")).toBeDefined();

    // Submit a different competitor — surferseo.com should be dropped.
    const res = await asUser()
      .post("/api/backlinks/audit")
      .send({ competitors: ["ahrefs.com"] });

    expect(res.status).toBe(200);

    const after = await auditRows();
    const targets = after.map((r) => r.target);
    expect(targets).not.toContain("surferseo.com");
    expect(targets).toContain("ahrefs.com");

    // Response must reflect the new benchmark only.
    const { audit } = res.body;
    expect(audit.competitors).toHaveLength(1);
    expect(audit.competitors[0].target).toBe("ahrefs.com");
  });
});
