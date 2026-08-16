import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
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

// The OAuth callback path needs Google's token exchange + sites.list mocked.
// Only OAuth2 (via a prototype-preserving Proxy on google.auth) and
// searchconsole are faked — everything else on googleapis stays real.
const { getTokenMock, sitesListMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn<(code: string) => Promise<{ tokens: Record<string, unknown> }>>(),
  sitesListMock: vi.fn<() => Promise<{ data: { siteEntry?: unknown[] } }>>(),
}));
vi.mock("googleapis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("googleapis")>();
  class FakeOAuth2 {
    getToken = getTokenMock;
    setCredentials = vi.fn();
    generateAuthUrl = vi.fn(() => "https://accounts.google.com/fake");
  }
  const auth = new Proxy(actual.google.auth, {
    get(target, prop, receiver) {
      if (prop === "OAuth2") return FakeOAuth2;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const googleFake = new Proxy(actual.google, {
    get(target, prop, receiver) {
      if (prop === "auth") return auth;
      if (prop === "searchconsole") return () => ({ sites: { list: sitesListMock } });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...actual, google: googleFake };
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
const { invalidateSiteCache } = await import("../lib/site");

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

/** Mirror integrations.ts's signState — HMAC over {siteId, userId, exp}. */
function signState(payload: { siteId: number; userId: string; exp: number }): string {
  const secret = process.env["SESSION_SECRET"] || process.env["CLERK_SECRET_KEY"];
  if (!secret) throw new Error("SESSION_SECRET or CLERK_SECRET_KEY must be set for this test");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function callbackWithState() {
  const state = signState({ siteId, userId: USER, exp: Date.now() + 60_000 });
  return request(app)
    .get("/api/integrations/gsc/callback")
    .query({ code: `test-code-${RUN}`, state });
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
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue({
    tokens: { refresh_token: `cb-refresh-${RUN}`, access_token: "at" },
  });
  sitesListMock.mockReset();
  sitesListMock.mockResolvedValue({
    data: { siteEntry: [{ siteUrl: PROPERTY, permissionLevel: "siteOwner" }] },
  });
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

describe("GET /api/integrations/gsc/callback triggers the refresh when a property auto-matches", () => {
  it("auto-match: measures waiting rows immediately after the OAuth callback", async () => {
    const waiting = await seedSub({ keyword: `callback kw ${RUN}` });
    const alreadyChecked = await seedSub({
      keyword: `callback checked ${RUN}`,
      impressions: 42,
      checkedAt: new Date("2026-07-01T00:00:00Z"),
    });

    const res = await callbackWithState();
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("gsc=connected");
    expect(getTokenMock).toHaveBeenCalledWith(`test-code-${RUN}`);

    // The waiting row gets measured within seconds — not "up to a day".
    const after = await waitForMeasurement(waiting.id);
    expect(after.exactImpressions28d).toBe(7); // 3 + 4
    expect(after.exactImpressionsCheckedAt).not.toBeNull();

    expect(queryGscDimensionMock).toHaveBeenCalledTimes(1);
    const call = queryGscDimensionMock.mock.calls[0]![0] as { siteId: number };
    expect(call.siteId).toBe(siteId);

    // The already-measured row keeps its original measurement.
    const checkedAfter = await readSub(alreadyChecked.id);
    expect(checkedAfter.exactImpressions28d).toBe(42);
    expect(checkedAfter.exactImpressionsCheckedAt?.getTime()).toBe(
      new Date("2026-07-01T00:00:00Z").getTime(),
    );

    // The integration row stored the matched property from the callback.
    const [integ] = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect((integ!.config as Record<string, unknown>)["property"]).toBe(PROPERTY);
  });

  it("no match: redirects to pick-property and does NOT refresh", async () => {
    const waiting = await seedSub({ keyword: `callback nomatch ${RUN}` });
    sitesListMock.mockResolvedValue({
      data: {
        siteEntry: [
          { siteUrl: `sc-domain:unrelated-${RUN}.example.org`, permissionLevel: "siteOwner" },
        ],
      },
    });

    const res = await callbackWithState();
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("gsc=pick-property");

    // No property matched → GSC isn't queryable yet → no refresh fired.
    await new Promise((r) => setTimeout(r, 300));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(waiting.id);
    expect(after.exactImpressions28d).toBeNull();
    expect(after.exactImpressionsCheckedAt).toBeNull();
  });

  it("unverified-permission properties are ignored for auto-matching", async () => {
    const waiting = await seedSub({ keyword: `callback unverified ${RUN}` });
    sitesListMock.mockResolvedValue({
      data: { siteEntry: [{ siteUrl: PROPERTY, permissionLevel: "siteUnverifiedUser" }] },
    });

    const res = await callbackWithState();
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("gsc=pick-property");

    await new Promise((r) => setTimeout(r, 300));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(waiting.id);
    expect(after.exactImpressionsCheckedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Security: forged / expired / misowned state must never attach an account
// ---------------------------------------------------------------------------

describe("GET /api/integrations/gsc/callback — security rejections", () => {
  /** Return the current integration rows for the test site (seeded in beforeEach). */
  async function getIntegrationRows() {
    return db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
  }

  it("rejects a tampered state signature → ?gsc=invalid, no DB row written", async () => {
    const goodState = signState({ siteId, userId: USER, exp: Date.now() + 60_000 });
    const [body] = goodState.split(".");
    // Replace the real signature with garbage of the same base64url alphabet.
    const tamperedState = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

    const before = await getIntegrationRows();

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `test-code-${RUN}`, state: tamperedState });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=invalid/);

    // No token exchange ever reached Google.
    expect(getTokenMock).not.toHaveBeenCalled();
    // The integration row is unchanged (no upsert occurred).
    const after = await getIntegrationRows();
    expect(after.length).toBe(before.length);
    const creds = after[0]?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
  });

  it("rejects an expired state token → ?gsc=invalid, no DB row written", async () => {
    const expiredState = signState({ siteId, userId: USER, exp: Date.now() - 1 });

    const before = await getIntegrationRows();

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `test-code-${RUN}`, state: expiredState });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=invalid/);
    expect(getTokenMock).not.toHaveBeenCalled();

    const after = await getIntegrationRows();
    expect(after.length).toBe(before.length);
    const creds = after[0]?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
  });

  it("rejects a state whose userId no longer owns the site → ?gsc=invalid, no DB row written", async () => {
    // The state is validly signed but carries a userId that is NOT the site owner.
    const intruderState = signState({
      siteId,
      userId: `intruder-user-${RUN}`,
      exp: Date.now() + 60_000,
    });

    const before = await getIntegrationRows();

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `test-code-${RUN}`, state: intruderState });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=invalid/);
    expect(getTokenMock).not.toHaveBeenCalled();

    const after = await getIntegrationRows();
    expect(after.length).toBe(before.length);
    const creds = after[0]?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
  });

  it("rejects a missing code parameter → ?gsc=invalid, no DB row written", async () => {
    const validState = signState({ siteId, userId: USER, exp: Date.now() + 60_000 });

    const before = await getIntegrationRows();

    // No `code` query param at all.
    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ state: validState });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=invalid/);
    expect(getTokenMock).not.toHaveBeenCalled();

    const after = await getIntegrationRows();
    expect(after.length).toBe(before.length);
    const creds = after[0]?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
  });

  it("?error=access_denied redirects to ?gsc=denied without touching the DB", async () => {
    const before = await getIntegrationRows();

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ error: "access_denied" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=denied/);
    expect(getTokenMock).not.toHaveBeenCalled();

    const after = await getIntegrationRows();
    expect(after.length).toBe(before.length);
    const creds = after[0]?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
  });
});

// ---------------------------------------------------------------------------
// Security: POST /integrations/gsc/property must block non-owners
// ---------------------------------------------------------------------------

describe("POST /api/integrations/gsc/property — ownership guard", () => {
  // A distinct user who has no ownership of the test site.
  const USER_B = `test-user-gscconnect-b-${RUN}`;

  async function readIntegrationRow() {
    const [row] = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    return row;
  }

  it("returns 403 when a non-owner tries to pick a property and leaves the integration row unchanged", async () => {
    const before = await readIntegrationRow();
    // Sanity: the seeded row has property: null so we can detect any unwanted write.
    expect((before?.config as Record<string, unknown> | undefined)?.["property"]).toBeNull();

    const res = await request(app)
      .post("/api/integrations/gsc/property")
      .set("x-test-user", USER_B)
      .set("x-site-id", String(siteId))
      .send({ property: PROPERTY });

    expect(res.status).toBe(403);

    // The integration row must be completely untouched.
    const after = await readIntegrationRow();
    const creds = after?.credentials as Record<string, unknown> | undefined;
    expect(creds?.["refreshToken"]).toBe(`test-refresh-${RUN}`);
    const config = after?.config as Record<string, unknown> | undefined;
    expect(config?.["property"]).toBeNull();

    // No background GSC query should have been triggered.
    await new Promise((r) => setTimeout(r, 200));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
  });

  it("returns 200 when the actual site owner picks a property", async () => {
    const res = await request(app)
      .post("/api/integrations/gsc/property")
      .set("x-test-user", USER)
      .set("x-site-id", String(siteId))
      .send({ property: PROPERTY });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The integration row now reflects the chosen property.
    const row = await readIntegrationRow();
    const config = row?.config as Record<string, unknown> | undefined;
    expect(config?.["property"]).toBe(PROPERTY);
  });

  /**
   * Former-owner scenario: USER_B owns the site, makes a successful request
   * (warming the site-owner cache), then ownership is transferred back to USER
   * via the same DB-update + invalidateSiteCache path that production code
   * uses. The former owner (USER_B) must be denied on the very next request —
   * before the 30-second TTL would naturally expire — and the new owner (USER)
   * must be allowed.
   */
  it("former owner is immediately denied after ownership transfer, new owner is allowed", async () => {
    // ── Step 1: transfer ownership to USER_B so it becomes the current owner.
    await db
      .update(sitesTable)
      .set({ ownerUserId: USER_B })
      .where(eq(sitesTable.id, siteId));
    invalidateSiteCache(siteId);

    // ── Step 2: USER_B (now the owner) warms the site cache with a successful pick.
    const firstRes = await request(app)
      .post("/api/integrations/gsc/property")
      .set("x-test-user", USER_B)
      .set("x-site-id", String(siteId))
      .send({ property: PROPERTY });
    expect(firstRes.status).toBe(200);

    // Re-seed the integration with property: null so we can detect any
    // unwanted write in the following assertion.
    await seedGscIntegration(siteId);

    // ── Step 3: transfer ownership back to USER (simulating a site transfer).
    // This is the same code path any ownership-change route would take.
    await db
      .update(sitesTable)
      .set({ ownerUserId: USER })
      .where(eq(sitesTable.id, siteId));
    invalidateSiteCache(siteId);

    // ── Step 4: USER_B (former owner) immediately tries to pick a property.
    // The cache was just invalidated so requireSite must re-fetch from the DB
    // and deny USER_B without waiting for the 30-second TTL.
    const deniedRes = await request(app)
      .post("/api/integrations/gsc/property")
      .set("x-test-user", USER_B)
      .set("x-site-id", String(siteId))
      .send({ property: PROPERTY });

    expect(deniedRes.status).toBe(403);

    // Integration row must be unchanged (property still null from re-seed).
    const afterDenied = await readIntegrationRow();
    const deniedConfig = afterDenied?.config as Record<string, unknown> | undefined;
    expect(deniedConfig?.["property"]).toBeNull();

    // ── Step 5: the new owner (USER) must still be allowed.
    const allowedRes = await request(app)
      .post("/api/integrations/gsc/property")
      .set("x-test-user", USER)
      .set("x-site-id", String(siteId))
      .send({ property: PROPERTY });

    expect(allowedRes.status).toBe(200);
    expect(allowedRes.body).toEqual({ ok: true });

    const afterAllowed = await readIntegrationRow();
    const allowedConfig = afterAllowed?.config as Record<string, unknown> | undefined;
    expect(allowedConfig?.["property"]).toBe(PROPERTY);
  });
});
