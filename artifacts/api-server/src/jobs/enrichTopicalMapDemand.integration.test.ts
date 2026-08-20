import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  sitesTable,
  topicalMapsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { claimNextQueuedMap } from "./enrichTopicalMapDemand";

const RUN = `${Date.now()}-${process.pid}`;
let siteId = 0;

beforeAll(async () => {
  const host = `demand-map-claim-${RUN}.example.com`;
  const [site] = await db
    .insert(sitesTable)
    .values({
      domain: `https://${host}/`,
      host,
      displayName: `Demand map claim ${RUN}`,
    })
    .returning({ id: sitesTable.id });
  siteId = site!.id;
});

afterAll(async () => {
  if (siteId) {
    await db
      .delete(topicalMapsTable)
      .where(eq(topicalMapsTable.siteId, siteId));
    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  }
});

describe("topical-map demand queue claims", () => {
  it("allows only one worker to claim an automatically queued map", async () => {
    const [map] = await db
      .insert(topicalMapsTable)
      .values({
        siteId,
        status: "complete",
        demandStatus: "queued",
        sourceContext: "Demand claim integration test context.",
        centralEntity: "Demand claim integration test",
        entitySynonyms: [],
        centralSearchIntent: "test demand claim concurrency",
        bordersWill: [],
        bordersWillNot: [],
      })
      .returning({ id: topicalMapsTable.id });

    const claims = await Promise.all([
      claimNextQueuedMap(siteId),
      claimNextQueuedMap(siteId),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(map!.id);

    const [stored] = await db
      .select()
      .from(topicalMapsTable)
      .where(eq(topicalMapsTable.id, map!.id));
    expect(stored?.demandStatus).toBe("running");
    expect(stored?.demandStartedAt).not.toBeNull();
  });
});