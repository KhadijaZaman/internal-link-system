import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  sitesTable,
  usersTable,
  jobRunsTable,
  auditReportsTable,
  linkStatsTable,
  inventoryTable,
} from "@workspace/db";
import { registerJob, type JobName } from "./runner";
import { runJobForAllSites } from "./scheduler";
import { runAuditOrphans } from "./audits";
import type { SiteContext } from "../lib/site";

/**
 * Integration test (real Postgres via DATABASE_URL): verifies the two
 * multi-tenant safety guarantees of the job system —
 *
 * 1. Failure isolation: when one site's job throws, runJobForAllSites still
 *    runs the job for every other site, and each site's job_runs row records
 *    its OWN outcome (error for the failing site, ok for the rest).
 * 2. Cross-tenant data scoping: a data-heavy job (audit_orphans) run for one
 *    site only reads and writes that site's rows — the other tenant's data
 *    is never touched or leaked into the report.
 *
 * The test registers a stub under a manual-only job name so no real job code
 * (crawls, API spend) ever executes; any pre-existing job_runs rows for that
 * name are snapshotted and restored afterwards.
 */

// Manual-only, never on a cron — safe to stub for the duration of this test.
const STUB_JOB: JobName = "migrate_url_hygiene";

const suffix = `${Date.now()}-${process.pid}`;
const USER_A = `user_test_iso_a_${suffix}`;
const USER_B = `user_test_iso_b_${suffix}`;
const HOST_A = `iso-a-${suffix}.test`;
const HOST_B = `iso-b-${suffix}.test`;

let siteA: SiteContext;
let siteB: SiteContext;
let priorJobRuns: (typeof jobRunsTable.$inferSelect)[] = [];

async function fetchSiteRow(id: number): Promise<SiteContext> {
  const [row] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!row) throw new Error(`test site ${id} missing`);
  return row;
}

beforeAll(async () => {
  // Snapshot every existing job_runs row for the stubbed job name so real
  // sites' job history can be restored exactly after the test.
  priorJobRuns = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.name, STUB_JOB));

  await db.insert(usersTable).values([{ id: USER_A }, { id: USER_B }]);
  const inserted = await db
    .insert(sitesTable)
    .values([
      {
        ownerUserId: USER_A,
        domain: HOST_A,
        host: HOST_A,
        displayName: "Isolation Test Site A",
      },
      {
        ownerUserId: USER_B,
        domain: HOST_B,
        host: HOST_B,
        displayName: "Isolation Test Site B",
      },
    ])
    .returning({ id: sitesTable.id });
  siteA = await fetchSiteRow(inserted[0]!.id);
  siteB = await fetchSiteRow(inserted[1]!.id);
});

afterAll(async () => {
  const ids = [siteA.id, siteB.id].filter((n) => Number.isInteger(n));
  if (ids.length > 0) {
    await db.delete(auditReportsTable).where(inArray(auditReportsTable.siteId, ids));
    await db.delete(linkStatsTable).where(inArray(linkStatsTable.siteId, ids));
    await db.delete(inventoryTable).where(inArray(inventoryTable.siteId, ids));
    await db.delete(jobRunsTable).where(inArray(jobRunsTable.siteId, ids));
    await db.delete(sitesTable).where(inArray(sitesTable.id, ids));
  }
  await db.delete(usersTable).where(inArray(usersTable.id, [USER_A, USER_B]));

  // Restore the stubbed job's pre-test job_runs rows for all other sites.
  await db.delete(jobRunsTable).where(eq(jobRunsTable.name, STUB_JOB));
  if (priorJobRuns.length > 0) {
    await db.insert(jobRunsTable).values(priorJobRuns);
  }
});

describe("runJobForAllSites failure isolation", () => {
  it("a throwing site does not block later sites, and each site records its own outcome", async () => {
    const calledSiteIds: number[] = [];
    registerJob(STUB_JOB, async (site) => {
      calledSiteIds.push(site.id);
      if (site.id === siteA.id) {
        throw new Error("forced failure for site A");
      }
    });

    await runJobForAllSites(STUB_JOB);

    // Both test sites were invoked, in ascending id order, so site B ran
    // AFTER site A's job threw.
    expect(calledSiteIds).toContain(siteA.id);
    expect(calledSiteIds).toContain(siteB.id);
    expect(calledSiteIds.indexOf(siteA.id)).toBeLessThan(calledSiteIds.indexOf(siteB.id));

    const runs = await db
      .select()
      .from(jobRunsTable)
      .where(
        and(eq(jobRunsTable.name, STUB_JOB), inArray(jobRunsTable.siteId, [siteA.id, siteB.id])),
      );
    const bySiteId = new Map(runs.map((r) => [r.siteId, r]));

    const runA = bySiteId.get(siteA.id);
    if (!runA) throw new Error("missing job_runs row for site A");
    expect(runA.lastStatus).toBe("error");
    expect(runA.lastError).toContain("forced failure for site A");

    const runB = bySiteId.get(siteB.id);
    if (!runB) throw new Error("missing job_runs row for site B");
    expect(runB.lastStatus).toBe("ok");
    expect(runB.lastError).toBeNull();
  });
});

describe("cross-tenant scoping (audit_orphans)", () => {
  it("a job run for one site only reads and writes that site's rows", async () => {
    const urlA = `https://${HOST_A}/orphan-a/`;
    const urlB = `https://${HOST_B}/orphan-b/`;
    // Seed an orphan candidate (0 inbound links + present in inventory) for
    // each tenant.
    await db.insert(linkStatsTable).values([
      { url: urlA, inboundCount: 0, siteId: siteA.id },
      { url: urlB, inboundCount: 0, siteId: siteB.id },
    ]);
    await db.insert(inventoryTable).values([
      { url: urlA, siteId: siteA.id },
      { url: urlB, siteId: siteB.id },
    ]);

    await runAuditOrphans(siteA);

    // Site A's report exists and contains ONLY site A's URL.
    const reportsA = await db
      .select()
      .from(auditReportsTable)
      .where(and(eq(auditReportsTable.siteId, siteA.id), eq(auditReportsTable.type, "orphans")));
    expect(reportsA.length).toBe(1);
    const payloadA = reportsA[0]!.payload as Array<{ url: string }>;
    expect(payloadA.map((p) => p.url)).toEqual([urlA]);

    // No report was written for site B — the job never touched the other tenant.
    const reportsB = await db
      .select()
      .from(auditReportsTable)
      .where(eq(auditReportsTable.siteId, siteB.id));
    expect(reportsB.length).toBe(0);

    // Site B's source rows are untouched.
    const statsB = await db
      .select()
      .from(linkStatsTable)
      .where(eq(linkStatsTable.siteId, siteB.id));
    expect(statsB.length).toBe(1);
    expect(statsB[0]!.url).toBe(urlB);
    expect(statsB[0]!.inboundCount).toBe(0);

    // Running the same job for site B then reports ONLY site B's URL —
    // scoping holds in both directions.
    await runAuditOrphans(siteB);
    const reportsB2 = await db
      .select()
      .from(auditReportsTable)
      .where(and(eq(auditReportsTable.siteId, siteB.id), eq(auditReportsTable.type, "orphans")));
    expect(reportsB2.length).toBe(1);
    const payloadB = reportsB2[0]!.payload as Array<{ url: string }>;
    expect(payloadB.map((p) => p.url)).toEqual([urlB]);
  });
});
