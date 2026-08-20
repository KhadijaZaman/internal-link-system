import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  db,
  queryIntelTable,
  sitesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureQueryMarketVolumes } from "./queryIntel";
import { refreshMarketVolumes } from "./queryIntel";

const RUN = `${Date.now()}-${process.pid}`;
const QUERY = `demand claim ${RUN}`.toLowerCase();
let siteId = 0;

beforeAll(async () => {
  const host = `demand-claim-${RUN}.example.com`;
  const [site] = await db
    .insert(sitesTable)
    .values({
      domain: `https://${host}/`,
      host,
      displayName: `Demand claim ${RUN}`,
    })
    .returning({ id: sitesTable.id });
  siteId = site!.id;
  process.env["DATAFORSEO_LOGIN"] = "test-login";
  process.env["DATAFORSEO_PASSWORD"] = "test-password";
});

afterAll(async () => {
  if (siteId) {
    await db
      .delete(queryIntelTable)
      .where(eq(queryIntelTable.siteId, siteId));
    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  }
});

describe("query-intel paid volume claims", () => {
  it("prevents overlapping workers from buying the same site/query/market twice", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const [task] = JSON.parse(String(init?.body)) as Array<{
          keywords: string[];
          location_code?: number;
        }>;
        const isUs = task.location_code === 2840;
        await new Promise((resolve) => setTimeout(resolve, isUs ? 100 : 200));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tasks: [
              {
                status_code: 20000,
                result: task.keywords.map((keyword) => ({
                  keyword,
                  search_volume: isUs ? 1_000 : 2_500,
                })),
              },
            ],
          }),
        } as Response;
      },
    );
    global.fetch = fetchMock;

    await Promise.all([
      ensureQueryMarketVolumes([QUERY], siteId),
      ensureQueryMarketVolumes([QUERY], siteId),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const markets = fetchMock.mock.calls.map((call) => {
      const [task] = JSON.parse(String(call[1]?.body)) as Array<{
        location_code?: number;
      }>;
      return task.location_code === 2840 ? "us" : "global";
    });
    expect(markets.sort()).toEqual(["global", "us"]);

    const [row] = await db
      .select()
      .from(queryIntelTable)
      .where(
        eq(queryIntelTable.siteId, siteId),
      );
    expect(row?.query).toBe(QUERY);
    expect(row?.searchVolume).toBe(1_000);
    expect(row?.globalSearchVolume).toBe(2_500);
    expect(row?.volumeFetchedAt).not.toBeNull();
    expect(row?.globalVolumeFetchedAt).not.toBeNull();
    expect(row?.volumeClaimedAt).toBeNull();
    expect(row?.volumeClaimToken).toBeNull();
    expect(row?.globalVolumeClaimedAt).toBeNull();
    expect(row?.globalVolumeClaimToken).toBeNull();

    await ensureQueryMarketVolumes([QUERY], siteId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prevents an expired claimant from overwriting or releasing a replacement claim", async () => {
    const query = `expired demand claim ${RUN}`.toLowerCase();
    const [seeded] = await db
      .insert(queryIntelTable)
      .values({ query, siteId })
      .returning();
    const firstMap = new Map([[query, seeded!]]);

    let resolveFirst:
      | ((value: {
          ok: boolean;
          status: number;
          json: () => Promise<unknown>;
        }) => void)
      | undefined;
    const firstResponse = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            {
              status_code: 20000,
              result: [{ keyword: query, search_volume: 2_000 }],
            },
          ],
        }),
      });
    global.fetch = fetchMock;

    const firstWorker = refreshMarketVolumes(
      [query],
      siteId,
      "us",
      firstMap,
      true,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [firstClaim] = await db
      .select()
      .from(queryIntelTable)
      .where(eq(queryIntelTable.query, query));
    expect(firstClaim?.volumeClaimToken).toBeTruthy();
    await db
      .update(queryIntelTable)
      .set({ volumeClaimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(queryIntelTable.query, query));

    const [beforeReplacement] = await db
      .select()
      .from(queryIntelTable)
      .where(eq(queryIntelTable.query, query));
    await refreshMarketVolumes(
      [query],
      siteId,
      "us",
      new Map([[query, beforeReplacement!]]),
      true,
    );

    const [afterReplacement] = await db
      .select()
      .from(queryIntelTable)
      .where(eq(queryIntelTable.query, query));
    expect(afterReplacement?.searchVolume).toBe(2_000);
    expect(afterReplacement?.volumeClaimToken).toBeNull();

    resolveFirst!({
      ok: true,
      status: 200,
      json: async () => ({
        tasks: [
          {
            status_code: 20000,
            result: [{ keyword: query, search_volume: 1_000 }],
          },
        ],
      }),
    });
    await firstWorker;

    const [finalRow] = await db
      .select()
      .from(queryIntelTable)
      .where(eq(queryIntelTable.query, query));
    expect(finalRow?.searchVolume).toBe(2_000);
    expect(finalRow?.volumeClaimToken).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains a claim after an indeterminate paid-request failure", async () => {
    const query = `indeterminate demand claim ${RUN}`.toLowerCase();
    const [seeded] = await db
      .insert(queryIntelTable)
      .values({ query, siteId })
      .returning();
    global.fetch = vi.fn().mockRejectedValue(new Error("response timed out"));

    await expect(
      refreshMarketVolumes(
        [query],
        siteId,
        "us",
        new Map([[query, seeded!]]),
        true,
      ),
    ).rejects.toThrow("indeterminate outcome");

    const [row] = await db
      .select()
      .from(queryIntelTable)
      .where(eq(queryIntelTable.query, query));
    expect(row?.volumeClaimedAt).not.toBeNull();
    expect(row?.volumeClaimToken).toBeTruthy();
    expect(row?.volumeFetchedAt).toBeNull();
  });
});