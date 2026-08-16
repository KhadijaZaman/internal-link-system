import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createHmac, randomBytes } from "node:crypto";
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
    // Embed the state in the returned URL so tests can round-trip through the
    // auth-url endpoint and extract the registered nonce for the callback.
    generateAuthUrl = vi.fn((opts: { state?: string }) =>
      `https://accounts.google.com/fake?state=${opts?.state ?? ""}`,
    );
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

/**
 * Mirror integrations.ts's signState — HMAC over {siteId, userId, exp, nonce}.
 * Each call generates a fresh nonce so two calls produce two distinct tokens,
 * just like two real OAuth initiations would.  Pass `nonce` explicitly when
 * you need to craft a state token for a nonce that was written directly to the
 * DB (cross-instance / restart simulation tests).
 */
function signState(payload: { siteId: number; userId: string; exp: number; nonce?: string }): string {
  const secret = process.env["SESSION_SECRET"] || process.env["CLERK_SECRET_KEY"];
  if (!secret) throw new Error("SESSION_SECRET or CLERK_SECRET_KEY must be set for this test");
  const nonce = payload.nonce ?? randomBytes(16).toString("hex");
  const body = Buffer.from(
    JSON.stringify({ siteId: payload.siteId, userId: payload.userId, exp: payload.exp, nonce }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Drive a complete GSC OAuth round-trip via the real server endpoints:
 *  1. POST /api/integrations/gsc/auth-url  — registers the active-flow nonce
 *  2. GET  /api/integrations/gsc/callback  — presents the state from (1)
 *
 * This is the only way to obtain a state token whose nonce is registered in
 * the server's per-site flow store.  Manually crafted state tokens (used by
 * the security-rejection tests) are intentionally NOT registered and therefore
 * fail at the nonce check.
 */
async function callbackWithState() {
  const authRes = await request(app)
    .post("/api/integrations/gsc/auth-url")
    .set("x-test-user", USER)
    .set("x-site-id", String(siteId));
  expect(authRes.status).toBe(200);
  // The mock embeds the state as a query-param so we can round-trip it.
  const url = new URL((authRes.body as { url: string }).url);
  const state = url.searchParams.get("state") ?? "";
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

// ---------------------------------------------------------------------------
// Per-site flow-nonce: replay protection and disconnect→reconnect race guard
//
// Only the state token issued by the most recent POST /integrations/gsc/auth-url
// call for a given site may complete its callback.  Older in-flight callbacks
// are rejected before the Google token exchange is attempted.
// ---------------------------------------------------------------------------

/**
 * Register a new GSC OAuth flow for the test site via the real server endpoint
 * and return the state token embedded in the returned Google-authorize URL.
 * getTokenMock is NOT configured here — set it in each test so the token
 * returned by the callback is explicit and deterministic.
 */
async function startFlow(): Promise<string> {
  const authRes = await request(app)
    .post("/api/integrations/gsc/auth-url")
    .set("x-test-user", USER)
    .set("x-site-id", String(siteId));
  expect(authRes.status).toBe(200);
  // The generateAuthUrl mock embeds ?state=<...> so we can round-trip it.
  const url = new URL((authRes.body as { url: string }).url);
  return url.searchParams.get("state") ?? "";
}

describe("GET /api/integrations/gsc/callback — per-site flow-nonce protection", () => {
  it("rejects a replayed state token — second callback after the nonce is consumed", async () => {
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `replay-token-${RUN}`, access_token: "at" },
    });
    const state = await startFlow();

    // First callback: nonce consumed, token stored.
    const res1 = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `replay-code-1-${RUN}`, state });
    expect(res1.status).toBe(302);
    expect(res1.headers["location"]).toMatch(/[?&]gsc=(connected|pick-property)/);
    expect(getTokenMock).toHaveBeenCalledTimes(1);

    const [rowAfterFirst] = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    const tokenAfterFirst = (rowAfterFirst!.credentials as Record<string, unknown>)["refreshToken"];
    expect(tokenAfterFirst).toBe(`replay-token-${RUN}`);

    // Second use of the same state: flow_nonce was cleared to NULL by the
    // first callback's conditional write, so the DB rejects this replay.
    // verifyFlowNonce returns true (map miss — consumeFlowNonce cleared the
    // in-memory entry), so getToken is called before the DB write fails;
    // that is correct and expected: the authoritative gate is the DB.
    getTokenMock.mockClear();
    const res2 = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `replay-code-2-${RUN}`, state });
    expect(res2.status).toBe(302);
    expect(res2.headers["location"]).toMatch(/[?&]gsc=invalid/);

    // Integration row is unchanged — the replay did not overwrite anything.
    const rowsAfterSecond = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect(rowsAfterSecond).toHaveLength(1);
    const tokenAfterSecond = (rowsAfterSecond[0]!.credentials as Record<string, unknown>)[
      "refreshToken"
    ];
    expect(tokenAfterSecond).toBe(`replay-token-${RUN}`);
  });

  it("old-flow callback is rejected after the owner initiates a second flow (supersede race)", async () => {
    // Flow A: initiate (registers nonce_A).
    const stateA = await startFlow();
    // Flow B: second auth-url supersedes nonce_A with nonce_B.
    const stateB = await startFlow();

    // Only flow B's callback will pass the nonce check and call getToken.
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `flow-b-token-${RUN}`, access_token: "at" },
    });

    // Fire both concurrently to simulate the race.
    const [resA, resB] = await Promise.all([
      request(app)
        .get("/api/integrations/gsc/callback")
        .query({ code: `race-code-a-${RUN}`, state: stateA }),
      request(app)
        .get("/api/integrations/gsc/callback")
        .query({ code: `race-code-b-${RUN}`, state: stateB }),
    ]);

    // Flow A carries the superseded nonce → rejected (before token exchange).
    // Flow B carries the current nonce → accepted.
    const responses = [resA, resB];
    const invalid = responses.filter((r) =>
      (r.headers["location"] as string).includes("gsc=invalid"),
    );
    const accepted = responses.filter((r) =>
      /gsc=(connected|pick-property)/.test(r.headers["location"] as string),
    );
    expect(invalid).toHaveLength(1);
    expect(accepted).toHaveLength(1);

    // Token exchange called exactly once — only the accepted flow reached it.
    expect(getTokenMock).toHaveBeenCalledTimes(1);


    // Exactly one integration row, holding only the token from the accepted flow.
    const rows = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect(rows).toHaveLength(1);
    const stored = (rows[0]!.credentials as Record<string, unknown>)["refreshToken"];
    expect(stored).toBe(`flow-b-token-${RUN}`);
  });

  it("pre-disconnect callback is rejected after disconnect + reconnect", async () => {
    // Step 1: owner initiates a GSC connect flow (nonce_A registered).
    const oldState = await startFlow();

    // Step 2: owner disconnects GSC — invalidates nonce_A.
    const disconnectRes = await request(app)
      .delete("/api/integrations/gsc")
      .set("x-test-user", USER)
      .set("x-site-id", String(siteId));
    expect(disconnectRes.status).toBe(200);

    // Step 3: owner reconnects — new flow with nonce_B.
    const newState = await startFlow();

    // Step 4: stale pre-disconnect callback arrives — nonce_A no longer matches
    // the site's active flow (nonce_B) → rejected before token exchange.
    getTokenMock.mockClear();
    const staleRes = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `stale-code-${RUN}`, state: oldState });
    expect(staleRes.status).toBe(302);
    expect(staleRes.headers["location"]).toMatch(/[?&]gsc=invalid/);
    expect(getTokenMock).not.toHaveBeenCalled();

    // Step 5: legitimate post-reconnect callback succeeds with nonce_B.
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `reconnect-token-${RUN}`, access_token: "at" },
    });
    const freshRes = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `fresh-code-${RUN}`, state: newState });
    expect(freshRes.status).toBe(302);
    expect(freshRes.headers["location"]).toMatch(/[?&]gsc=(connected|pick-property)/);

    // Only the post-reconnect token is stored.
    const rows = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect(rows).toHaveLength(1);
    const stored = (rows[0]!.credentials as Record<string, unknown>)["refreshToken"];
    expect(stored).toBe(`reconnect-token-${RUN}`);
  });

  it("in-flight callback that started before disconnect cannot write credentials after reconnect", async () => {
    // Step 1: owner initiates a flow — nonce_A is registered.
    const oldState = await startFlow();

    // Step 2: Deferred token gate + a synchronization flag so we know exactly
    // when the old callback has passed verifyFlowNonce and the DB ownership
    // check and is suspended inside getToken.  Using a flag (rather than a
    // fixed setTimeout) prevents a race where verifyFlowNonce rejects the
    // callback before it ever calls getToken — which would leave the
    // mockImplementationOnce entry in the queue and corrupt the new callback's mock.
    let resolveOldToken!: (value: { tokens: Record<string, unknown> }) => void;
    const oldTokenGate = new Promise<{ tokens: Record<string, unknown> }>((resolve) => {
      resolveOldToken = resolve;
    });
    let getTokenReached = false;
    getTokenMock.mockImplementationOnce(async () => {
      getTokenReached = true; // signal: old callback has passed verifyFlowNonce
      return oldTokenGate;   // suspend here until we call resolveOldToken
    });

    // Step 3: Fire the old callback immediately using .end() so the HTTP
    // request is dispatched without awaiting the full response.  Supertest's
    // Test object only sends the request when .then()/.end() is called, so
    // storing the chain in a variable without calling either keeps the request
    // pending locally but never delivers it to the server.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldCallbackPromise = new Promise<any>((resolve) => {
      request(app)
        .get("/api/integrations/gsc/callback")
        .query({ code: `inflight-old-code-${RUN}`, state: oldState })
        .end((_err, res) => resolve(res));
    });

    // Step 4: Poll until getToken is actually called — the old callback is
    // guaranteed to be suspended inside getToken at this point.
    const deadline = Date.now() + 3000;
    while (!getTokenReached && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // If this assertion fails the test environment couldn't deliver the
    // in-flight scenario; the rest of the test would be meaningless.
    expect(getTokenReached).toBe(true);

    // Step 5: Owner disconnects GSC while the old callback is suspended.
    // invalidateFlowNonce clears nonce_A from activeFlowNonce.
    const disconnectRes = await request(app)
      .delete("/api/integrations/gsc")
      .set("x-test-user", USER)
      .set("x-site-id", String(siteId));
    expect(disconnectRes.status).toBe(200);

    // Step 6: Owner immediately reconnects — nonce_B registered.
    const newState = await startFlow();

    // Step 7: Release the old callback.  It resumes from getToken, runs the
    // conditional DB UPDATE WHERE flow_nonce = nonce_A.  The disconnect in
    // step 5 deleted the row (including flow_nonce), then the reconnect in
    // step 6 created a new row with flow_nonce = nonce_B.  The WHERE clause
    // matches 0 rows → callback redirects to ?gsc=invalid without writing.
    resolveOldToken({ tokens: { refresh_token: `inflight-old-token-${RUN}`, access_token: "at" } });
    const oldRes = await oldCallbackPromise;
    expect(oldRes.status).toBe(302);
    expect(oldRes.headers["location"]).toMatch(/[?&]gsc=invalid/);

    // Step 8: The new-flow callback succeeds.  Reset the mock now that the
    // old callback's once-queue entry is confirmed consumed (getTokenReached).
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `inflight-new-token-${RUN}`, access_token: "at" },
    });
    const newRes = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `inflight-new-code-${RUN}`, state: newState });
    expect(newRes.status).toBe(302);
    expect(newRes.headers["location"]).toMatch(/[?&]gsc=(connected|pick-property)/);

    // Only the post-reconnect token is stored — the old in-flight callback
    // must not have written anything.
    const rows = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect(rows).toHaveLength(1);
    const stored = (rows[0]!.credentials as Record<string, unknown>)["refreshToken"];
    expect(stored).toBe(`inflight-new-token-${RUN}`);
  });

  it("callback succeeds when nonce is in the DB but not in the in-memory map (simulates restart or cross-instance routing)", async () => {
    // Write a flow_nonce directly to the DB, bypassing POST /auth-url so the
    // nonce is never registered in the in-memory activeFlowNonce map.  This
    // simulates a server restart or a callback routed to a different instance.
    const nonce = randomBytes(16).toString("hex");
    const exp = Date.now() + 15 * 60 * 1000;
    await db
      .insert(siteIntegrationsTable)
      .values({
        siteId,
        provider: "gsc",
        credentials: {},
        config: { property: null, availableProperties: [] },
        flowNonce: nonce,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [siteIntegrationsTable.siteId, siteIntegrationsTable.provider],
        set: { flowNonce: nonce, updatedAt: new Date() },
      });
    invalidateIntegrationCache(siteId, "gsc");

    // Craft a valid state token using the explicit nonce — this is NOT in the
    // in-memory map, so verifyFlowNonce returns true (map miss = don't reject).
    // The DB conditional write is the authoritative gate.
    const state = signState({ siteId, userId: USER, exp, nonce });
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `restart-token-${RUN}`, access_token: "at" },
    });

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `restart-code-${RUN}`, state });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=(connected|pick-property)/);

    const [row] = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    const stored = (row!.credentials as Record<string, unknown>)["refreshToken"];
    expect(stored).toBe(`restart-token-${RUN}`);
  });

  it("stale callback is rejected after disconnect even when the in-memory map is empty (simulates cross-instance disconnect)", async () => {
    // Set up a flow nonce directly in the DB only (not in memory).
    const nonce = randomBytes(16).toString("hex");
    const exp = Date.now() + 15 * 60 * 1000;
    await db
      .insert(siteIntegrationsTable)
      .values({
        siteId,
        provider: "gsc",
        credentials: {},
        config: { property: null, availableProperties: [] },
        flowNonce: nonce,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [siteIntegrationsTable.siteId, siteIntegrationsTable.provider],
        set: { flowNonce: nonce, updatedAt: new Date() },
      });
    invalidateIntegrationCache(siteId, "gsc");

    // Owner disconnects GSC — deletes the DB row (and the flow_nonce with it).
    const disconnectRes = await request(app)
      .delete("/api/integrations/gsc")
      .set("x-test-user", USER)
      .set("x-site-id", String(siteId));
    expect(disconnectRes.status).toBe(200);

    // Craft a state token for the old nonce.  In-memory map is empty (nonce
    // was never registered there), so verifyFlowNonce returns true (map miss).
    // The DB conditional write must be the one that rejects: the DELETE above
    // removed the row so UPDATE WHERE flow_nonce = $nonce matches 0 rows.
    const state = signState({ siteId, userId: USER, exp, nonce });
    // getToken will be called (verifyFlowNonce passes on map miss) before the
    // DB write rejects — configure the mock to prevent an unhandled error.
    getTokenMock.mockResolvedValue({
      tokens: { refresh_token: `stale-cross-token-${RUN}`, access_token: "at" },
    });

    const res = await request(app)
      .get("/api/integrations/gsc/callback")
      .query({ code: `stale-cross-code-${RUN}`, state });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/[?&]gsc=invalid/);

    // Integration row must not exist — disconnect deleted it and the stale
    // callback must not have re-created it.
    const rows = await db
      .select()
      .from(siteIntegrationsTable)
      .where(eq(siteIntegrationsTable.siteId, siteId));
    expect(rows).toHaveLength(0);
  });
});
