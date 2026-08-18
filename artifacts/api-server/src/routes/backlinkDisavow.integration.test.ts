import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, sitesTable, usersTable, backlinkDisavowTable } from "@workspace/db";

/**
 * Integration tests for the disavow persistence routes.
 *
 * Verifies the core requirements of task #171:
 *  1. PUT /api/backlinks/disavow/:domain saves a decision in the DB.
 *  2. GET /api/backlinks/disavow returns the saved decision after an audit refresh.
 *  3. Decisions are isolated per site — site A's decisions never appear for site B.
 *  4. DELETE removes a decision; subsequent GET no longer returns it.
 *  5. GET /api/backlinks/disavow/export returns a text/plain disavow.txt whose
 *     contents include exactly the "disavow" decisions and exclude "keep" ones.
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

// ─── DataForSEO mock (used by the audit route) ────────────────────────────────

vi.mock("../integrations/dataforseo", () => ({
  fetchBacklinkSummary: vi.fn((target: string) =>
    Promise.resolve({
      target,
      rank: 500,
      backlinks: 10000,
      referringDomains: 500,
      referringMainDomains: 400,
      brokenBacklinks: 2,
      referringIps: 300,
      dofollow: 7000,
      nofollow: 3000,
      firstSeen: "2021-01-01",
    }),
  ),
  fetchBacklinkAnchors: vi.fn(() => Promise.resolve([])),
  fetchTopBacklinks: vi.fn(() => Promise.resolve([])),
  fetchTopReferringDomains: vi.fn(() =>
    Promise.resolve([
      { domain: "evil-spam.xyz", backlinks: 500, rank: 2, firstSeen: null, lastSeen: null },
      { domain: "good-blog.com", backlinks: 120, rank: 750, firstSeen: "2023-01-01", lastSeen: null },
    ]),
  ),
  isDataForSeoOutOfFunds: vi.fn(() => false),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

const { default: app } = await import("../app");

const RUN = `${Date.now()}-${process.pid}`;
const USER_A = `test-disavow-user-a-${RUN}`;
const USER_B = `test-disavow-user-b-${RUN}`;

let siteIdA: number;
let siteIdB: number;

function asUser(userId: string, siteId: number) {
  const base = request(app);
  return {
    get: (url: string) =>
      base.get(url).set("x-test-user", userId).set("x-site-id", String(siteId)),
    put: (url: string) =>
      base.put(url).set("x-test-user", userId).set("x-site-id", String(siteId)),
    delete: (url: string) =>
      base.delete(url).set("x-test-user", userId).set("x-site-id", String(siteId)),
    post: (url: string) =>
      base.post(url).set("x-test-user", userId).set("x-site-id", String(siteId)),
  };
}

function agentA() {
  return asUser(USER_A, siteIdA);
}
function agentB() {
  return asUser(USER_B, siteIdB);
}

beforeAll(async () => {
  await db
    .insert(usersTable)
    .values([{ id: USER_A }, { id: USER_B }])
    .onConflictDoNothing({ target: usersTable.id });

  const [rowA] = await db
    .insert(sitesTable)
    .values({
      domain: `https://disavow-test-a-${RUN}.example.com/`,
      host: `disavow-test-a-${RUN}.example.com`,
      displayName: `Disavow Test A ${RUN}`,
      ownerUserId: USER_A,
    })
    .returning({ id: sitesTable.id });

  const [rowB] = await db
    .insert(sitesTable)
    .values({
      domain: `https://disavow-test-b-${RUN}.example.com/`,
      host: `disavow-test-b-${RUN}.example.com`,
      displayName: `Disavow Test B ${RUN}`,
      ownerUserId: USER_B,
    })
    .returning({ id: sitesTable.id });

  siteIdA = rowA!.id;
  siteIdB = rowB!.id;
});

afterAll(async () => {
  await db.delete(sitesTable).where(eq(sitesTable.id, siteIdA));
  await db.delete(sitesTable).where(eq(sitesTable.id, siteIdB));
  await db.delete(usersTable).where(inArray(usersTable.id, [USER_A, USER_B]));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/backlinks/disavow — initial state", () => {
  it("returns an empty decisions array when no decisions have been saved", async () => {
    const res = await agentA().get("/api/backlinks/disavow");
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
  });
});

describe("PUT /api/backlinks/disavow/:domain — saving decisions", () => {
  it("saves a disavow decision and returns 200", async () => {
    const res = await agentA()
      .put("/api/backlinks/disavow/evil-spam.xyz")
      .send({ decision: "disavow" });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("disavow");
    expect(res.body.domain).toBe("evil-spam.xyz");
  });

  it("GET returns the saved decision immediately after PUT", async () => {
    const res = await agentA().get("/api/backlinks/disavow");
    expect(res.status).toBe(200);
    const match = (res.body.decisions as Array<{ domain: string; decision: string }>).find(
      (d) => d.domain === "evil-spam.xyz",
    );
    expect(match).toBeDefined();
    expect(match!.decision).toBe("disavow");
  });

  it("saves a keep decision for a different domain", async () => {
    const res = await agentA()
      .put("/api/backlinks/disavow/good-blog.com")
      .send({ decision: "keep" });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("keep");
  });

  it("rejects an unknown decision value with 400", async () => {
    const res = await agentA()
      .put("/api/backlinks/disavow/some-domain.com")
      .send({ decision: "ignore" });
    expect(res.status).toBe(400);
  });
});

describe("Disavow decisions survive an audit refresh", () => {
  it("decisions persist after a new POST /api/backlinks/audit run", async () => {
    // Run a fresh audit (simulated, no real DataForSEO calls).
    const auditRes = await agentA()
      .post("/api/backlinks/audit")
      .send({ competitors: [], refresh: true });
    expect(auditRes.status).toBe(200);

    // Fetch decisions — must still be there.
    const res = await agentA().get("/api/backlinks/disavow");
    expect(res.status).toBe(200);

    const decisions = res.body.decisions as Array<{ domain: string; decision: string }>;
    const disavowed = decisions.find((d) => d.domain === "evil-spam.xyz");
    const kept = decisions.find((d) => d.domain === "good-blog.com");

    expect(disavowed).toBeDefined();
    expect(disavowed!.decision).toBe("disavow");
    expect(kept).toBeDefined();
    expect(kept!.decision).toBe("keep");
  });
});

describe("GET /api/backlinks/disavow/export — disavow.txt output", () => {
  it("returns text/plain with only disavow-decision domains, not keep decisions", async () => {
    const res = await agentA().get("/api/backlinks/disavow/export");
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/text\/plain/);

    const body: string = res.text;
    // Must contain the disavowed domain.
    expect(body).toContain("evil-spam.xyz");
    // Must NOT contain the kept domain.
    expect(body).not.toContain("good-blog.com");
  });
});

describe("Site isolation — decisions scoped to site ID", () => {
  it("site B starts with no decisions even though site A has decisions", async () => {
    const res = await agentB().get("/api/backlinks/disavow");
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
  });

  it("site B can save its own decisions independently", async () => {
    const putRes = await agentB()
      .put("/api/backlinks/disavow/evil-spam.xyz")
      .send({ decision: "keep" }); // site B keeps this domain — opposite of A
    expect(putRes.status).toBe(200);

    // Site A's decision for the same domain must be unchanged.
    const aRes = await agentA().get("/api/backlinks/disavow");
    const aDecision = (aRes.body.decisions as Array<{ domain: string; decision: string }>).find(
      (d) => d.domain === "evil-spam.xyz",
    );
    expect(aDecision!.decision).toBe("disavow");

    // Site B sees its own decision.
    const bRes = await agentB().get("/api/backlinks/disavow");
    const bDecision = (bRes.body.decisions as Array<{ domain: string; decision: string }>).find(
      (d) => d.domain === "evil-spam.xyz",
    );
    expect(bDecision!.decision).toBe("keep");
  });
});

describe("DELETE /api/backlinks/disavow/:domain — clearing decisions", () => {
  it("removes the decision and it no longer appears in GET", async () => {
    const delRes = await agentA().delete("/api/backlinks/disavow/evil-spam.xyz");
    expect(delRes.status).toBe(200);

    const res = await agentA().get("/api/backlinks/disavow");
    const match = (res.body.decisions as Array<{ domain: string }>).find(
      (d) => d.domain === "evil-spam.xyz",
    );
    expect(match).toBeUndefined();
  });

  it("the export no longer includes the deleted domain", async () => {
    const res = await agentA().get("/api/backlinks/disavow/export");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("evil-spam.xyz");
  });

  it("also cleans up the DB row directly", async () => {
    const rows = await db
      .select()
      .from(backlinkDisavowTable)
      .where(eq(backlinkDisavowTable.siteId, siteIdA));
    // Only the "keep" decision for good-blog.com should remain for site A.
    expect(rows.every((r) => r.domain !== "evil-spam.xyz")).toBe(true);
  });
});
