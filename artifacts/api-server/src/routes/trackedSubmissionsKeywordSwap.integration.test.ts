import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  jobRunsTable,
  sitesTable,
  usersTable,
  trackedSubmissionsTable,
} from "@workspace/db";

/**
 * Dead-phrase badge reset on keyword swap (real Postgres via DATABASE_URL,
 * real Express app, Clerk + the GSC query mocked at the module boundary).
 *
 * Changing a tracked keyword (PATCH, or re-pasting via the POST upsert) must
 * clear exact_impressions_28d / exact_impressions_checked_at so the badge
 * never shows the OLD keyword's numbers, then re-measure in the background.
 * A no-op PATCH (same keyword, or status-only) must leave the measurement
 * intact. refreshExactImpressions itself is unit-tested with a mocked
 * queryGscDimension (sums 28d impressions, skips keyword-less rows, scopes
 * updates by site).
 */

// GSC is replaced with a controllable fake; everything else in the module
// (withCache, regex helpers, …) stays real. The in-memory withCache keys on
// url+keyword+day, so tests use unique URLs/keywords to avoid cache hits.
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

// Clerk replaced with a header-driven fake (same pattern as the
// cross-site-isolation test): `x-test-user` is the verified user id.
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
const { refreshExactImpressions } = await import(
  "../services/keywordMovementSheet"
);

const RUN = `${Date.now()}-${process.pid}`;
const USER = `test-user-kwswap-${RUN}`;
let siteId: number;
let otherSiteId: number;
let urlSeq = 0;

function uniqueUrl(): string {
  urlSeq += 1;
  return `https://kwswap-${RUN}.example.com/page-${urlSeq}`;
}

function api() {
  const base = (m: "get" | "post" | "patch") => (url: string) =>
    request(app)[m](url).set("x-test-user", USER).set("x-site-id", String(siteId));
  return { get: base("get"), post: base("post"), patch: base("patch") };
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
    if (row.exactImpressions28d != null) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Insert a tracked submission directly with a pre-existing measurement. */
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

beforeAll(async () => {
  await db
    .insert(usersTable)
    .values([{ id: USER }])
    .onConflictDoNothing({ target: usersTable.id });
  const rows = await db
    .insert(sitesTable)
    .values([
      {
        domain: `kwswap-${RUN}.example.com`,
        host: `kwswap-${RUN}.example.com`,
        displayName: `KW swap ${RUN}`,
        ownerUserId: USER,
      },
      {
        domain: `kwswap-other-${RUN}.example.com`,
        host: `kwswap-other-${RUN}.example.com`,
        displayName: `KW swap other ${RUN}`,
        ownerUserId: USER,
      },
    ])
    .returning({ id: sitesTable.id, domain: sitesTable.domain });
  siteId = rows.find((r) => r.domain.startsWith(`kwswap-${RUN}`))!.id;
  otherSiteId = rows.find((r) => r.domain.startsWith(`kwswap-other-`))!.id;
});

afterAll(async () => {
  await db
    .delete(trackedSubmissionsTable)
    .where(
      inArray(trackedSubmissionsTable.siteId, [siteId, otherSiteId].filter(Boolean)),
    );
  await db
    .delete(jobRunsTable)
    .where(inArray(jobRunsTable.siteId, [siteId, otherSiteId].filter(Boolean)));
  await db
    .delete(sitesTable)
    .where(inArray(sitesTable.id, [siteId, otherSiteId].filter(Boolean)));
  await db.delete(usersTable).where(eq(usersTable.id, USER));
});

beforeEach(() => {
  queryGscDimensionMock.mockReset();
  // Default: the background re-measurement finds some impressions.
  queryGscDimensionMock.mockResolvedValue(gscRows([3, 4]));
});

describe("PATCH keyword change clears the measurement", () => {
  it("changed keyword clears exact_impressions_28d/checked_at, then re-measures", async () => {
    const sub = await seedSub({
      keyword: `old phrase ${RUN} a`,
      impressions: 0, // dead-phrase badge showing
      checkedAt: new Date("2026-07-01T00:00:00Z"),
    });

    const res = await api()
      .patch(`/api/tracked-submissions/${sub.id}`)
      .send({ keyword: `new phrase ${RUN} a` });
    expect(res.status).toBe(200);
    // The response itself must already show the cleared measurement — the
    // badge must never render the old keyword's numbers.
    expect(res.body.keyword).toBe(`new phrase ${RUN} a`);
    expect(res.body.exactImpressions28d).toBeNull();
    expect(res.body.exactImpressionsCheckedAt).toBeNull();

    // Background refresh re-measures with the NEW keyword.
    const after = await waitForMeasurement(sub.id);
    expect(after.exactImpressions28d).toBe(7); // 3 + 4
    expect(after.exactImpressionsCheckedAt).not.toBeNull();
    const call = queryGscDimensionMock.mock.calls[0]?.[0] as {
      siteId: number;
      queryFilter?: { expression: string };
    };
    expect(call.siteId).toBe(siteId);
    expect(call.queryFilter?.expression).toContain("new");
  });

  it("clearing the keyword (null) clears the measurement without re-measuring", async () => {
    const sub = await seedSub({
      keyword: `old phrase ${RUN} b`,
      impressions: 12,
      checkedAt: new Date("2026-07-01T00:00:00Z"),
    });
    const res = await api()
      .patch(`/api/tracked-submissions/${sub.id}`)
      .send({ keyword: null });
    expect(res.status).toBe(200);
    expect(res.body.keyword).toBeNull();
    expect(res.body.exactImpressions28d).toBeNull();
    expect(res.body.exactImpressionsCheckedAt).toBeNull();

    // No keyword left to measure — background refresh must not fire GSC.
    await new Promise((r) => setTimeout(r, 200));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBeNull();
  });
});

describe("no-op PATCH leaves the measurement intact", () => {
  it("same keyword (incl. surrounding whitespace) keeps the measurement", async () => {
    const checkedAt = new Date("2026-07-10T00:00:00Z");
    const sub = await seedSub({
      keyword: `same phrase ${RUN}`,
      impressions: 0,
      checkedAt,
    });
    const res = await api()
      .patch(`/api/tracked-submissions/${sub.id}`)
      .send({ keyword: `  same phrase ${RUN}  ` });
    expect(res.status).toBe(200);
    expect(res.body.exactImpressions28d).toBe(0);
    expect(new Date(res.body.exactImpressionsCheckedAt).getTime()).toBe(
      checkedAt.getTime(),
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBe(0);
    expect(after.exactImpressionsCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });

  it("status-only PATCH keeps the measurement", async () => {
    const checkedAt = new Date("2026-07-11T00:00:00Z");
    const sub = await seedSub({
      keyword: `status only ${RUN}`,
      impressions: 55,
      checkedAt,
    });
    const res = await api()
      .patch(`/api/tracked-submissions/${sub.id}`)
      .send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.exactImpressions28d).toBe(55);

    await new Promise((r) => setTimeout(r, 200));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBe(55);
    expect(after.exactImpressionsCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });
});

describe("POST upsert keyword change clears the measurement", () => {
  it("re-pasting a URL with a NEW keyword clears and re-measures", async () => {
    const sub = await seedSub({
      keyword: `paste old ${RUN}`,
      impressions: 0,
      checkedAt: new Date("2026-07-05T00:00:00Z"),
    });
    const res = await api()
      .post("/api/tracked-submissions")
      .send({ items: [{ url: sub.url, keyword: `paste new ${RUN}` }] });
    expect(res.status).toBe(201);
    const returned = (res.body as Array<{ id: number; keyword: string; exactImpressions28d: number | null; exactImpressionsCheckedAt: string | null }>).find(
      (r) => r.id === sub.id,
    );
    expect(returned).toBeDefined();
    expect(returned!.keyword).toBe(`paste new ${RUN}`);
    expect(returned!.exactImpressions28d).toBeNull();
    expect(returned!.exactImpressionsCheckedAt).toBeNull();

    const after = await waitForMeasurement(sub.id);
    expect(after.exactImpressions28d).toBe(7);
    expect(after.exactImpressionsCheckedAt).not.toBeNull();
  });

  it("re-pasting the SAME keyword leaves the measurement intact", async () => {
    const checkedAt = new Date("2026-07-06T00:00:00Z");
    const sub = await seedSub({
      keyword: `paste same ${RUN}`,
      impressions: 9,
      checkedAt,
    });
    const res = await api()
      .post("/api/tracked-submissions")
      .send({ items: [{ url: sub.url, keyword: `paste same ${RUN}` }] });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 200));
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBe(9);
    expect(after.exactImpressionsCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });
});

describe("refreshExactImpressions (unit, mocked GSC)", () => {
  it("sums 28d impressions (rounded) and stamps checked_at", async () => {
    const sub = await seedSub({ keyword: `unit sum ${RUN}` });
    queryGscDimensionMock.mockResolvedValue(gscRows([1.4, 2.4, 10]));
    const count = await refreshExactImpressions(siteId, [
      { id: sub.id, url: sub.url, keyword: sub.keyword },
    ]);
    expect(count).toBe(1);
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBe(14); // round(13.8)
    expect(after.exactImpressionsCheckedAt).not.toBeNull();

    // Trailing 28-day window, exact-ish keyword filter, US-only.
    const call = queryGscDimensionMock.mock.calls[0]![0] as {
      siteId: number;
      startDate: string;
      endDate: string;
      countryFilter: string;
      queryFilter: { operator: string };
    };
    expect(call.siteId).toBe(siteId);
    expect(call.countryFilter).toBe("usa");
    expect(call.queryFilter.operator).toBe("includingRegex");
    const spanDays =
      (new Date(`${call.endDate}T00:00:00Z`).getTime() -
        new Date(`${call.startDate}T00:00:00Z`).getTime()) /
        86_400_000 +
      1;
    expect(spanDays).toBe(28);
  });

  it("skips keyword-less rows and only counts the measured ones", async () => {
    const withKw = await seedSub({ keyword: `unit skip ${RUN}` });
    const noKw = await seedSub({ keyword: null });
    const blankKw = await seedSub({ keyword: "   " });
    queryGscDimensionMock.mockResolvedValue(gscRows([5]));

    const count = await refreshExactImpressions(siteId, [
      { id: withKw.id, url: withKw.url, keyword: withKw.keyword },
      { id: noKw.id, url: noKw.url, keyword: null },
      { id: blankKw.id, url: blankKw.url, keyword: "   " },
    ]);
    expect(count).toBe(1);
    expect(queryGscDimensionMock).toHaveBeenCalledTimes(1);

    expect((await readSub(withKw.id)).exactImpressions28d).toBe(5);
    expect((await readSub(noKw.id)).exactImpressions28d).toBeNull();
    expect((await readSub(blankKw.id)).exactImpressions28d).toBeNull();
  });

  it("returns 0 and never queries GSC when nothing has a keyword", async () => {
    const sub = await seedSub({ keyword: null });
    const count = await refreshExactImpressions(siteId, [
      { id: sub.id, url: sub.url, keyword: null },
    ]);
    expect(count).toBe(0);
    expect(queryGscDimensionMock).not.toHaveBeenCalled();
  });

  it("scopes the DB write by site — a mismatched siteId updates nothing", async () => {
    // Row belongs to siteId, but the refresh runs as otherSiteId: the GSC
    // query is scoped to otherSiteId and the UPDATE's site guard means the
    // row keeps its old (null) measurement.
    const sub = await seedSub({ keyword: `unit scope ${RUN}`, siteId });
    queryGscDimensionMock.mockResolvedValue(gscRows([99]));
    await refreshExactImpressions(otherSiteId, [
      { id: sub.id, url: sub.url, keyword: sub.keyword },
    ]);
    const call = queryGscDimensionMock.mock.calls[0]![0] as { siteId: number };
    expect(call.siteId).toBe(otherSiteId);
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBeNull();
    expect(after.exactImpressionsCheckedAt).toBeNull();
  });

  it("propagates GSC errors to the caller", async () => {
    const sub = await seedSub({ keyword: `unit error ${RUN}` });
    queryGscDimensionMock.mockRejectedValue(new Error("gsc boom"));
    await expect(
      refreshExactImpressions(siteId, [
        { id: sub.id, url: sub.url, keyword: sub.keyword },
      ]),
    ).rejects.toThrow("gsc boom");
    const after = await readSub(sub.id);
    expect(after.exactImpressions28d).toBeNull();
  });
});
