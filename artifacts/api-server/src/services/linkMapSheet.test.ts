/**
 * Unit tests for artifacts/api-server/src/services/linkMapSheet.ts
 *
 * Strategy
 * --------
 * - Mock @workspace/db (db query chain + appStateTable)
 * - Mock ../integrations/googleSheets (sheetsRequest + shareSheetWithAnyone)
 * - Cover: create new sheet, reuse existing tab, add missing tab, replace
 *   deleted sheet (403), aggregation, placement filtering, error propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const { mockEdges, mockSheetsRequest, mockShareSheetWithAnyone, limitMock, onConflictMock } =
  vi.hoisted(() => {
    const mockEdges: Array<{
      sourceUrl: string;
      targetUrl: string;
      placement: string;
      anchorText: string | null;
    }> = [];

    const mockSheetsRequest = vi.fn();
    const mockShareSheetWithAnyone = vi.fn().mockResolvedValue(true);
    // app_state reads (.limit()) default to "no row".
    const limitMock = vi.fn().mockResolvedValue([]);
    const onConflictMock = vi.fn().mockResolvedValue(undefined);

    return { mockEdges, mockSheetsRequest, mockShareSheetWithAnyone, limitMock, onConflictMock };
  });

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  const whereChain = {
    limit: limitMock,
    // Also thenable so `await db.select().from(t).where(c)` resolves to mockEdges.
    get then() {
      return (resolve: (v: unknown) => void) => resolve(mockEdges);
    },
  };
  const fromChain = { where: vi.fn().mockReturnValue(whereChain) };
  const selectChain = { from: vi.fn().mockReturnValue(fromChain) };
  const valuesChain = { onConflictDoUpdate: onConflictMock };
  const insertChain = { values: vi.fn().mockReturnValue(valuesChain) };
  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
  return {
    db,
    linkGraphTable: { siteId: "siteId" },
    appStateTable: { key: "key" },
    eq: vi.fn((a: unknown, b: unknown) => ({ col: a, val: b })),
  };
});

vi.mock("../integrations/googleSheets", () => ({
  sheetsRequest: (...args: unknown[]) => mockSheetsRequest(...args),
  shareSheetWithAnyone: (...args: unknown[]) => mockShareSheetWithAnyone(...args),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  exportLinkMapSheet,
  getStoredLinkMapSheetUrl,
  isLinkMapSheetShared,
  NoLinkDataError,
} from "./linkMapSheet";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE = { id: 42, displayName: "Acme Blog", host: "acme.com" };

function seedEdges(
  count = 3,
  opts: { placement?: string } = {},
) {
  mockEdges.length = 0;
  for (let i = 0; i < count; i++) {
    mockEdges.push({
      sourceUrl: `https://acme.com/page-${i}`,
      targetUrl: `https://acme.com/target-${i}`,
      placement: opts.placement ?? "content",
      anchorText: `anchor ${i}`,
    });
  }
}

/**
 * Default sheetsRequest responder:
 * - POST /v4/spreadsheets → create new spreadsheet
 * - GET  /v4/spreadsheets/ID?fields=… → metadata
 * - everything else → ok {}
 */
function defaultSheetsImpl(path: string, init?: unknown) {
  const method = (init as { method?: string } | undefined)?.method;
  if (path === "/v4/spreadsheets" && method === "POST") {
    return Promise.resolve({
      spreadsheetId: "NEW_ID",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/NEW_ID/edit",
    });
  }
  if (path.includes("?fields=")) {
    return Promise.resolve({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/NEW_ID/edit",
      sheets: [{ properties: { sheetId: 1, title: "Link Map", gridProperties: { rowCount: 100, columnCount: 5 } } }],
    });
  }
  return Promise.resolve({});
}

// ─── Tests: exportLinkMapSheet ────────────────────────────────────────────────

describe("exportLinkMapSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEdges.length = 0;
    limitMock.mockResolvedValue([]);
    onConflictMock.mockResolvedValue(undefined);
    mockSheetsRequest.mockImplementation(defaultSheetsImpl);
    mockShareSheetWithAnyone.mockResolvedValue(true);
  });

  it("throws NoLinkDataError when the site has no matching edges", async () => {
    // mockEdges is empty → no edges.
    await expect(exportLinkMapSheet(SITE)).rejects.toBeInstanceOf(NoLinkDataError);
  });

  it("throws NoLinkDataError when all edges are nav and showNav is false", async () => {
    seedEdges(3, { placement: "nav" });
    await expect(exportLinkMapSheet(SITE, { showNav: false })).rejects.toBeInstanceOf(NoLinkDataError);
  });

  it("creates a new spreadsheet when no sheet ID is stored", async () => {
    seedEdges(3);

    const result = await exportLinkMapSheet(SITE);

    expect(result.url).toContain("NEW_ID");
    expect(result.title).toBe("Link Map — Acme Blog");
    expect(result.rowCount).toBe(3);
    expect(result.sheetShared).toBe(true);

    const createCall = mockSheetsRequest.mock.calls.find(
      (c) => c[0] === "/v4/spreadsheets" && (c[1] as { method?: string })?.method === "POST",
    );
    expect(createCall).toBeTruthy();
  });

  it("persists the new spreadsheet ID in app_state", async () => {
    seedEdges(2);
    await exportLinkMapSheet(SITE);
    expect(onConflictMock).toHaveBeenCalled();
  });

  it("updates only the Link Map tab when a stored sheet is found (no tab deletion)", async () => {
    seedEdges(4);

    // First limit → sheet ID row; remaining → no shared marker.
    limitMock.mockResolvedValueOnce([{ value: "EXISTING_ID" }]);

    mockSheetsRequest.mockImplementation((path: string, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method;
      if (path.includes("EXISTING_ID") && !method) {
        return Promise.resolve({
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/EXISTING_ID/edit",
          sheets: [
            { properties: { sheetId: 1, title: "Link Map", gridProperties: { rowCount: 10, columnCount: 5 } } },
            { properties: { sheetId: 2, title: "My Notes", gridProperties: { rowCount: 50, columnCount: 10 } } },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await exportLinkMapSheet(SITE);

    expect(result.url).toContain("EXISTING_ID");
    expect(result.rowCount).toBe(4);

    // No deleteSheet requests — only the Link Map tab was touched.
    // Exclude /values:batchUpdate (value writes) and only check structural batchUpdates.
    const structuralBatchCalls = mockSheetsRequest.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes(":batchUpdate") &&
        !c[0].includes("/values:batchUpdate") &&
        (c[1] as { method?: string })?.method === "POST",
    );
    for (const [, init] of structuralBatchCalls) {
      const body = (init as { body: { requests?: Array<{ deleteSheet?: unknown }> } }).body;
      const requests = body.requests ?? [];
      expect(requests.some((r) => "deleteSheet" in r)).toBe(false);
    }
  });

  it("adds a Link Map tab when the stored sheet exists but the tab is missing", async () => {
    seedEdges(2);
    limitMock.mockResolvedValueOnce([{ value: "STORED_ID" }]);

    mockSheetsRequest.mockImplementation((path: string, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method;
      if (path.includes("STORED_ID") && !method) {
        return Promise.resolve({
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/STORED_ID/edit",
          sheets: [
            { properties: { sheetId: 7, title: "Other Tab", gridProperties: { rowCount: 100, columnCount: 5 } } },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await exportLinkMapSheet(SITE);
    expect(result.url).toContain("STORED_ID");

    // An addSheet request should have been issued.
    const batchCalls = mockSheetsRequest.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes(":batchUpdate") && (c[1] as { method?: string })?.method === "POST",
    );
    const addSheetFound = batchCalls.some(([, init]) =>
      (init as { body: { requests: Array<{ addSheet?: unknown }> } }).body.requests.some((r) => "addSheet" in r),
    );
    expect(addSheetFound).toBe(true);
  });

  it("creates a fresh sheet when the stored sheet returns 403", async () => {
    seedEdges(2);
    limitMock.mockResolvedValueOnce([{ value: "STALE_ID" }]);

    mockSheetsRequest.mockImplementation((path: string, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method;
      if (path.includes("STALE_ID") && !method) {
        return Promise.reject(
          new Error("Google Sheets API GET /v4/spreadsheets/STALE_ID failed (403): Forbidden"),
        );
      }
      if (path === "/v4/spreadsheets" && method === "POST") {
        return Promise.resolve({ spreadsheetId: "FRESH_ID" });
      }
      return Promise.resolve({});
    });

    const result = await exportLinkMapSheet(SITE);
    expect(result.url).toContain("FRESH_ID");
  });

  it("respects placement filters — nav links included only when showNav=true", async () => {
    mockEdges.length = 0;
    mockEdges.push(
      { sourceUrl: "https://a.com/p1", targetUrl: "https://a.com/p2", placement: "content", anchorText: "link" },
      { sourceUrl: "https://a.com/p1", targetUrl: "https://a.com/p3", placement: "nav", anchorText: "nav link" },
    );

    // Without showNav: only 1 row.
    const r1 = await exportLinkMapSheet(SITE, { showNav: false });
    expect(r1.rowCount).toBe(1);

    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
    onConflictMock.mockResolvedValue(undefined);
    mockSheetsRequest.mockImplementation(defaultSheetsImpl);
    mockShareSheetWithAnyone.mockResolvedValue(true);

    // With showNav: 2 rows.
    const r2 = await exportLinkMapSheet(SITE, { showNav: true });
    expect(r2.rowCount).toBe(2);
  });

  it("respects placement filters — footer links included only when showFooter=true", async () => {
    mockEdges.length = 0;
    mockEdges.push(
      { sourceUrl: "https://a.com/p1", targetUrl: "https://a.com/p2", placement: "content", anchorText: "link" },
      { sourceUrl: "https://a.com/p1", targetUrl: "https://a.com/p3", placement: "footer", anchorText: "footer link" },
    );

    const r1 = await exportLinkMapSheet(SITE, { showFooter: false });
    expect(r1.rowCount).toBe(1);

    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
    onConflictMock.mockResolvedValue(undefined);
    mockSheetsRequest.mockImplementation(defaultSheetsImpl);
    mockShareSheetWithAnyone.mockResolvedValue(true);

    const r2 = await exportLinkMapSheet(SITE, { showFooter: true });
    expect(r2.rowCount).toBe(2);
  });

  it("aggregates multiple anchors for the same source→target→placement triple", async () => {
    mockEdges.length = 0;
    mockEdges.push(
      { sourceUrl: "https://acme.com/a", targetUrl: "https://acme.com/b", placement: "content", anchorText: "first anchor" },
      { sourceUrl: "https://acme.com/a", targetUrl: "https://acme.com/b", placement: "content", anchorText: "second anchor" },
      { sourceUrl: "https://acme.com/a", targetUrl: "https://acme.com/b", placement: "content", anchorText: "first anchor" }, // duplicate
    );

    const result = await exportLinkMapSheet(SITE);
    expect(result.rowCount).toBe(1); // 3 raw edges → 1 aggregated row

    const valuesCall = mockSheetsRequest.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/values:batchUpdate"),
    );
    expect(valuesCall).toBeTruthy();
    const body = (valuesCall as unknown[])[1] as { body: { data: Array<{ values: unknown[][] }> } };
    const dataRow = body.body.data[0].values[1]; // index 0 = header

    expect(dataRow[3]).toBe(3); // links count
    const anchors = dataRow[4] as string;
    expect(anchors).toContain("first anchor");
    expect(anchors).toContain("second anchor");
    expect((anchors.match(/first anchor/g) ?? []).length).toBe(1); // de-duped
  });

  it("propagates non-403/404 Sheets API errors without creating a duplicate", async () => {
    seedEdges(2);
    limitMock.mockResolvedValueOnce([{ value: "STORED_ID" }]);
    mockSheetsRequest.mockRejectedValue(
      new Error("Google Sheets API GET /v4/spreadsheets/STORED_ID failed (500): Server Error"),
    );
    await expect(exportLinkMapSheet(SITE)).rejects.toThrow("500");
  });

  it("returns sheetShared: false when Drive connector is unavailable", async () => {
    seedEdges(1);
    mockShareSheetWithAnyone.mockResolvedValue(false);
    const result = await exportLinkMapSheet(SITE);
    expect(result.sheetShared).toBe(false);
  });
});

// ─── Tests: getStoredLinkMapSheetUrl ─────────────────────────────────────────

describe("getStoredLinkMapSheetUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it("returns null when no sheet ID is stored", async () => {
    expect(await getStoredLinkMapSheetUrl(42)).toBeNull();
  });

  it("returns a Google Sheets edit URL when an ID is stored", async () => {
    limitMock.mockResolvedValue([{ value: "MY_SHEET_ID" }]);
    expect(await getStoredLinkMapSheetUrl(42)).toBe(
      "https://docs.google.com/spreadsheets/d/MY_SHEET_ID/edit",
    );
  });
});

// ─── Tests: isLinkMapSheetShared ─────────────────────────────────────────────

describe("isLinkMapSheetShared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it("returns false when no sheet ID is stored", async () => {
    expect(await isLinkMapSheetShared(42)).toBe(false);
  });

  it("returns true when the stored and shared IDs match", async () => {
    limitMock
      .mockResolvedValueOnce([{ value: "SHEET_ID" }])
      .mockResolvedValueOnce([{ value: "SHEET_ID" }]);
    expect(await isLinkMapSheetShared(42)).toBe(true);
  });

  it("returns false when the IDs differ (sharing failed)", async () => {
    limitMock
      .mockResolvedValueOnce([{ value: "SHEET_ID" }])
      .mockResolvedValueOnce([{ value: "OLD_ID" }]);
    expect(await isLinkMapSheetShared(42)).toBe(false);
  });
});
