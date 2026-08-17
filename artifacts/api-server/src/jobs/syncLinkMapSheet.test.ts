import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSyncLinkMapSheet } from "./syncLinkMapSheet";

vi.mock("../services/linkMapSheet", () => ({
  getStoredLinkMapSheetUrl: vi.fn(),
  exportLinkMapSheet: vi.fn(),
  NoLinkDataError: class NoLinkDataError extends Error {
    constructor(msg?: string) {
      super(msg ?? "no link data");
      this.name = "NoLinkDataError";
    }
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getStoredLinkMapSheetUrl,
  exportLinkMapSheet,
  NoLinkDataError,
} from "../services/linkMapSheet";

const mockGetUrl = vi.mocked(getStoredLinkMapSheetUrl);
const mockExport = vi.mocked(exportLinkMapSheet);

const fakeSite = { id: 42 } as Parameters<typeof runSyncLinkMapSheet>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSyncLinkMapSheet", () => {
  it("skips export when no sheet URL is stored", async () => {
    mockGetUrl.mockResolvedValue(null);

    await runSyncLinkMapSheet(fakeSite);

    expect(mockGetUrl).toHaveBeenCalledWith(fakeSite.id);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("calls exportLinkMapSheet when a sheet URL is present", async () => {
    mockGetUrl.mockResolvedValue(
      "https://docs.google.com/spreadsheets/d/abc123/edit",
    );
    mockExport.mockResolvedValue({ rowCount: 10, title: "Link Map" } as Awaited<
      ReturnType<typeof exportLinkMapSheet>
    >);

    await runSyncLinkMapSheet(fakeSite);

    expect(mockGetUrl).toHaveBeenCalledWith(fakeSite.id);
    expect(mockExport).toHaveBeenCalledWith(fakeSite);
  });

  it("swallows NoLinkDataError without rethrowing", async () => {
    mockGetUrl.mockResolvedValue(
      "https://docs.google.com/spreadsheets/d/abc123/edit",
    );
    mockExport.mockRejectedValue(new NoLinkDataError());

    await expect(runSyncLinkMapSheet(fakeSite)).resolves.toBeUndefined();
    expect(mockExport).toHaveBeenCalledWith(fakeSite);
  });

  it("rethrows unexpected errors", async () => {
    mockGetUrl.mockResolvedValue(
      "https://docs.google.com/spreadsheets/d/abc123/edit",
    );
    mockExport.mockRejectedValue(new Error("sheets API down"));

    await expect(runSyncLinkMapSheet(fakeSite)).rejects.toThrow(
      "sheets API down",
    );
  });
});
