import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  sitesTable,
  usersTable,
  trackedSubmissionsTable,
  siteIntegrationsTable,
} from "@workspace/db";

/**
 * Post-GSC-connect keyword refresh (real Postgres via DATABASE_URL, real
 * Express app, Clerk + the GSC query mocked at the module boundary — same
 * pattern as trackedSubmissionsKeywordSwap.integration.test.ts).
 *
 * When GSC becomes usable for a site (here: the owner picks a property via
 * POST /api/integrations/gsc/property), refreshUnmeasuredKeywordsInBackground
 * must immediately measure tracked rows that are still waiting — i.e. ONLY
 * rows with a keyword AND exact_impressions_checked_at IS NULL, scoped to
 * that site. Rows already measured, rows without a keyword, and other sites'
 * rows must be untouched. If GSC turns out not to be usable (e.g.
 * IntegrationNotConnectedError from the query layer), the failure is logged
 * and swallowed — the property-pick request itself still succeeds.
 */

const { queryGscDimensionMock } = vi.hoisted(() => ({
  queryGscDimensionMock: vi.fn<(opts: unknown) => Promise<unknown[]>>(),
}));
vi.mock("../integrations/gsc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integrations/gsc")>();
  return {
    ...actual,
    queryGscDimension: queryGscDimensionMock,
  };
});

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

// Import AFTER the mocks so app.ts / the service pick up the fakes.
const { default: app } = await import("../app");
const { invalidateIntegrationCache } = await import("../lib/siteIntegrations");

const RUN = `${Date.now()}-${process.pid}`;
const USER = `test-user-gscconnect-${RUN}`;
const PROPERTY = `sc-domain:gscconnect-${RUN}.example.com`;
let siteId: number;
let otherSiteId: number;
let urlSeq = 0;

function uniqueUrl(): string {
  urlSeq += 1;
  return `https://gscconnect-${RUN}.example.com/page-${urlSeq}`;
}

function gscRows(impressions: number[]): unknown[] {
  return impressions.map((impr, i) => ({
    key: `2026-07-${String(i + 1).padStart(2, "0")}`,
    clicks: 0,
    impressions: impr,
    ctr: 0,
    position: 5,
  }));
}

async function readSub(id: number) {
  const [row] = await db
    .select()
    .from(trackedSubmissionsTable)
    .where(eq(trackedSubmissionsTable.id, id));
  return row!;
}

/** Poll until the background refresh has written a measurement (or timeout). */
async function waitForMeasurement(id: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readSub(id);
    if (row.exactImpressionsCheckedAt != null) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedSub(opts: {
  siteId?: number;
  keyword: string | null;
  impressions?: number | null;
  checkedAt?: Date | null;
}) {
  const [row] = await db
    .insert(trackedSubmissionsTable)
    .values({
      siteId: opts.siteId ?? siteId,
      url: uniqueUrl(),
      keyword: opts.keyword,
      exactImpressions28d: opts.impressions ?? null,
      exactImpressionsCheckedAt: opts.checkedAt ?? null,
    })
    .returning();
  return row!;
}

/** Seed a connected-GSC row (refresh token + available properties list). */
async function seedGscIntegration(forSiteId: number): Promise<void> {
  await db
    .insert(siteIntegrationsTable)
    .values({
      siteId: forSiteId,
      provider: "gsc",
      credentials: { refreshToken: `test-refresh-${RUN}` },
      config: { property: null, availableProperties: [PROPERTY] },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [siteIntegrationsTable.siteId, siteIntegrationsTable.provider],
      set: {
        credentials: { refreshToken: `test-refresh-${RUN}` },
        config: { property: null, availableProperties: [PROPERTY] },
        updatedAt: new Date(),
      },
    });
  // getIntegrationRow caches for 30s — the direct DB seed must bust it.
  invalidateIntegrationCache(forSiteId, "gsc");
}

function pickProperty() {
  return request(app)
    .post("/api/integrations/gsc/property")
    .set("x-test-user", USER)
    .set("x-site-id", String(siteId))
    .send({ property: PROPERTY });
}

beforeAll(async () => {
  await db
    .insert(usersTable)
    .values([{ id: USER }])
    .onConflictDoNothing({ target: usersTable.id });
  const rows = await db
    .insert(sitesTable)
    .values([
      {
        domain: `gscconnect-${RUN}.example.com`,
        host: `gscconnect-${RUN}.example.com`,
        displayName: `GSC connect ${RUN}`,
        ownerUserId: USER,
      },
      {
        domain: `gscconnect-other-${RUN}.example.com`,
        host: `gscconnect-other-${RUN}.example.com`,
        displayName: `GSC connect other ${RUN}`,
        ownerUserId: USER,
      },
    ])
    .returning({ id: sitesTable.id, domain: sitesTable.domain });
  siteId = rows.find((r) => r.domain.startsWith(`gscconnect-${RUN}`))!.id;
  otherSiteId = rows.find((r) => r.domain.startsWith(`gscconnect-other-`))!.id;
});

afterAll(async () => {
  const ids = [siteId, otherSiteId].filter(Boolean);
  await db
    .delete(trackedSubmissionsTable)
    .where(inArray(trackedSubmissionsTable.siteId, ids));
  await db
    .delete(siteIntegrationsTable)
    .where(inArray(siteIntegrationsTable.siteId, ids));
  await db.delete(sitesTable).where(inArray(sitesTable.id, ids));
  await db.delete(usersTable).where(eq(usersTable.id, USER));
});

beforeEach(async () => {
  queryGscDimensionMock.mockReset();
  queryGscDimensionMock.mockResolvedValue(gscRows([3, 4]));
  // Fresh unmeasured rows per test would collide across tests — instead each
  // test seeds its own rows and the property pick re-runs the refresh, so
  // clear the site's tracked rows between tests.
  await db
    .delete(trackedSubmissionsTable)
    .where(inArray(trackedSubmissionsTable.siteId, [siteId, otherSiteId]));
  await seedGscIntegration(siteId);
});

describe("POST /api/integrations/gsc/property triggers the waiting-keyword refresh", () => {
  it("measures ONLY rows with a keyword and null checked_at, scoped to the site", async () => {
    const waiting = await seedSub({ keyword: `waiting kw ${RUN}` });
    const alreadyChecked = await seedSub({
      keyword: `checked kw ${RUN}`,
      impressions: 42,
      checkedAt: new Date("2026-07-01T00:00:00Z"),
    });
    const noKeyword = await seedSub({ keyword: null });
    const blankKeyword = await seedSub({ keyword: "   " });
    const otherSite = await seedSub({
      siteId: otherSiteId,
      keyword: `other site kw ${RUN}`,
    });

    const res = await pickProperty();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The waiting row gets measured within seconds — not "up to a day".
    const after = await waitForMeasurement(waiting.id);
    expect(after.exactImpressions28d).toBe(7); // 3 + 4
    expect(after.exactImpressionsCheckedAt).not.toBeNull();

    // Exactly one GSC call: the waiting row. The query is scoped to the site
    // and filters to the waiting row's keyword.
    expect(queryGscDimensionMock).toHaveBeenCalledTimes(1);
    const call = queryGscDimensionMock.mock.calls[0]![0] as {
      siteId: number;
      queryFilter?: { expression: string };
    };
    expect(call.siteId).toBe(siteId);
    expect(call.queryFilter?.expression).toContain("waiting");

    // Already-measured row keeps its original measurement.
    const checkedAfter = await readSub(alreadyChecked.id);
    expect(checkedAfter.exactImpressions28d).toBe(42);
    expect(checkedAfter.exactImpressionsCheckedAt?.getTime()).toBe(
      new Date("2026-07-01T00:00:00Z").getTime(),
    );

    // Keyword-less / blank-keyword / other-site rows are untouched.
    for (const id of [noKeyword.id, blankKeyword.id, otherSite.id]) {
      const row = await readSub(id);
      expect(row.exactImpressions28d).toBeNull();
      expect(row.exactImpressionsCheckedAt).toBeNull();
    }
  });

  it("does not query GSC at all when no rows are waiting", async () => {
    await seedSub({
      keyword: `all checked ${RUN}`,
      impressions: 5,
      checkedAt: new Date("2026-07-02T00:00:00Z"),
    });
    await seedSub({ keyword: null });

    const res = await pickProperty();
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
  });

  it("swallows GSC-not-connected failures — the request still succeeds", async () => {
    const { IntegrationNotConnectedError } = await import("../lib/siteIntegrations");
    const waiting = await seedSub({ keyword: `not connected kw ${RUN}` });
    queryGscDimensionMock.mockRejectedValue(
      new IntegrationNotConnectedError("gsc", siteId),
    );

    const res = await pickProperty();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The background refresh failed quietly: the row stays unmeasured (the
    // daily sync self-heals later) and nothing crashed the process.
    await new Promise((r) => setTimeout(r, 300));
    const after = await readSub(waiting.id);
    expect(after.exactImpressions28d).toBeNull();
    expect(after.exactImpressionsCheckedAt).toBeNull();
  });

  it("swallows unexpected refresh errors too — the request still succeeds", async () => {
    const waiting = await seedSub({ keyword: `boom kw ${RUN}` });
    queryGscDimensionMock.mockRejectedValue(new Error("gsc boom"));

    const res = await pickProperty();
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    const after = await readSub(waiting.id);
    expect(after.exactImpressionsCheckedAt).toBeNull();
  });
});
