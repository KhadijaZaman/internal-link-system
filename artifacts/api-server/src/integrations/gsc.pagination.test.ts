import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../lib/siteIntegrations", () => ({
  getGscCreds: vi.fn(async () => ({
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    property: "sc-domain:test.example",
  })),
}));

vi.mock("googleapis", () => {
  class OAuth2 {
    setCredentials(): void {}
  }
  return {
    google: {
      auth: { OAuth2 },
      searchconsole: () => ({
        searchanalytics: { query: queryMock },
      }),
    },
  };
});

const { queryGscDimension, queryGscQueryPage } = await import("./gsc");

function dimensionRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    keys: [`query-${i}`],
    clicks: 1,
    impressions: 2,
    ctr: 0.5,
    position: 3,
  }));
}

function queryPageRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    keys: [`query-${i}`, `https://test.example/page-${i}`],
    clicks: 1,
    impressions: 2,
    ctr: 0.5,
    position: 3,
  }));
}

describe("GSC bounded pagination", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("shrinks the final dimension request to the remaining cap and fails closed when it is full", async () => {
    const requested: number[] = [];
    queryMock.mockImplementation(async ({ requestBody }) => {
      requested.push(requestBody.rowLimit);
      return { data: { rows: dimensionRows(requestBody.rowLimit) } };
    });

    await expect(
      queryGscDimension({
        siteId: 1,
        startDate: "2026-01-01",
        endDate: "2026-01-07",
        dimension: "query",
        rowLimit: 4,
        paginated: true,
        paginatedCap: 5,
      }),
    ).rejects.toThrow(/safety cap of 5 rows/i);

    expect(requested).toEqual([4, 1]);
  });

  it("returns a short final dimension page without overshooting the cap", async () => {
    queryMock
      .mockResolvedValueOnce({ data: { rows: dimensionRows(4) } })
      .mockResolvedValueOnce({ data: { rows: [] } });

    const rows = await queryGscDimension({
      siteId: 1,
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      dimension: "query",
      rowLimit: 4,
      paginated: true,
      paginatedCap: 5,
    });

    expect(rows).toHaveLength(4);
    expect(queryMock.mock.calls[1]![0].requestBody.rowLimit).toBe(1);
  });

  it("applies the same remaining allowance to query-page pagination", async () => {
    const requests: Array<Record<string, any>> = [];
    queryMock.mockImplementation(async ({ requestBody }) => {
      requests.push(requestBody);
      return { data: { rows: queryPageRows(requestBody.rowLimit) } };
    });

    await expect(
      queryGscQueryPage({
        siteId: 1,
        startDate: "2026-01-01",
        endDate: "2026-01-07",
        pageSize: 4,
        maxRows: 5,
        countryFilter: "usa",
        queryRegex: "^(query-1|query-2)$",
      }),
    ).rejects.toThrow(/safety cap of 5 rows/i);

    expect(requests.map((request) => request.rowLimit)).toEqual([4, 1]);
    expect(requests[0]!.dimensionFilterGroups).toEqual([
      {
        filters: [
          { dimension: "country", operator: "equals", expression: "usa" },
          {
            dimension: "query",
            operator: "includingRegex",
            expression: "^(query-1|query-2)$",
          },
        ],
      },
    ]);
  });
});