import { describe, expect, it, vi } from "vitest";
import { appStateTable, db } from "@workspace/db";
import { like } from "drizzle-orm";

vi.mock("../integrations/googleSheets", () => ({
  sheetsRequest: vi.fn(),
}));

import { sheetsRequest } from "../integrations/googleSheets";
import {
  exportOpportunitiesSheet,
  getOpportunitiesSheetInfo,
  parseOpportunitySheetRows,
  replaceOpportunitySheetValues,
  withOpportunitiesSheetLock,
} from "./opportunitiesSheet";
import type { SiteContext } from "../lib/site";

const headers = [
  "Site ID",
  "Action ID",
  "Version",
  "Category",
  "Opportunity",
  "Target URL",
  "Score",
  "Score Components",
  "Source Evidence",
  "Freshness",
  "Owner",
  "Status",
  "Due Date",
  "Market",
];

describe("parseOpportunitySheetRows", () => {
  it("accepts only whitelisted review fields for the active site", () => {
    const result = parseOpportunitySheetRows(
      [
        headers,
        [7, 42, 3, "content", "Changed read-only title", "https://other", 999, "{}", "[]", "fresh", "Ava", "done", "2026-09-01", "US"],
      ],
      7,
    );
    expect(result).toEqual({
      invalid: 0,
      valid: [{
        id: 42,
        expectedVersion: 3,
        owner: "Ava",
        status: "done",
        dueDate: "2026-09-01",
        market: "US",
      }],
    });
  });

  it("rejects cross-site, invalid-status, and malformed-date rows", () => {
    const result = parseOpportunitySheetRows(
      [
        headers,
        [8, 42, 3, "", "", "", "", "", "", "", "", "done", "", "US"],
        [7, 43, 1, "", "", "", "", "", "", "", "", "approved", "", "US"],
        [7, 44, 1, "", "", "", "", "", "", "", "", "open", "09/01/26", "US"],
      ],
      7,
    );
    expect(result.valid).toEqual([]);
    expect(result.invalid).toBe(3);
  });

  it("fails closed when governed headers are changed", () => {
    expect(() => parseOpportunitySheetRows([headers.filter((h) => h !== "Version")], 7))
      .toThrow("headers were changed");
  });
});

describe("governed Opportunities sheet refresh", () => {
  it("keeps the prior sheet intact when the replacement write fails", async () => {
    const request = vi.mocked(sheetsRequest);
    request.mockReset();
    request.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      replaceOpportunitySheetValues("sheet-id", [["Action ID"], [42]]),
    ).rejects.toThrow("write failed");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
  });

  it("serializes the full export/import section across database clients", async () => {
    const siteId = 920_000 + (process.pid % 1_000);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOpportunitiesSheetLock(siteId, async () => {
      order.push("first:start");
      firstEntered();
      await release;
      order.push("first:end");
    });
    await firstHasLock;
    const second = withOpportunitiesSheetLock(siteId, async () => {
      order.push("second:start");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not retain a first-time binding when workbook access fails", async () => {
    const request = vi.mocked(sheetsRequest);
    request.mockReset();
    const siteId = 930_000 + (process.pid % 1_000);
    const spreadsheetId = "valid-sheet-id-1234567890";
    const site = {
      id: siteId,
      displayName: "Binding rollback test",
    } as SiteContext;
    await db
      .delete(appStateTable)
      .where(like(appStateTable.key, `opportunities_sheet:${siteId}:%`));

    try {
      request.mockRejectedValueOnce(new Error("forbidden"));
      await expect(
        exportOpportunitiesSheet(site, spreadsheetId),
      ).rejects.toThrow("forbidden");
      expect((await getOpportunitiesSheetInfo(siteId)).url).toBeNull();

      request
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          sheets: [{ properties: { sheetId: 1, title: "Opportunities" } }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await expect(
        exportOpportunitiesSheet(site, spreadsheetId),
      ).resolves.toMatchObject({ rowCount: 0 });
      expect((await getOpportunitiesSheetInfo(siteId)).url).toContain(spreadsheetId);
    } finally {
      await db
        .delete(appStateTable)
        .where(like(appStateTable.key, `opportunities_sheet:${siteId}:%`));
    }
  });
});