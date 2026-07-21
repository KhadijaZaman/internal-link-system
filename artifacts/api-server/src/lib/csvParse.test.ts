import { describe, expect, it } from "vitest";
import { csvToObjects, normalizeHeader, parseCsv } from "./csvParse";
import { parseBingDate } from "../integrations/bing";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('name,note\n"Smith, John","said ""hi"""')).toEqual([
      ["name", "note"],
      ["Smith, John", 'said "hi"'],
    ]);
  });

  it("handles newlines inside quoted fields", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("handles CRLF and CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("\uFEFFurl,citations\n/x,5")).toEqual([
      ["url", "citations"],
      ["/x", "5"],
    ]);
  });

  it("drops empty trailing rows", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("csvToObjects", () => {
  it("keys rows by normalized headers and keeps raw headers", () => {
    const { rawHeaders, rows } = csvToObjects(
      "Page URL,Total Citations\nhttps://x.com/a,12",
    );
    expect(rawHeaders).toEqual(["Page URL", "Total Citations"]);
    expect(rows).toEqual([
      { "page url": "https://x.com/a", "total citations": "12" },
    ]);
  });

  it("pads missing cells with empty strings", () => {
    const { rows } = csvToObjects("a,b,c\n1,2");
    expect(rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });
});

describe("normalizeHeader", () => {
  it("lowercases and collapses punctuation", () => {
    expect(normalizeHeader("  Total_Citations (28d) ")).toBe(
      "total citations 28d",
    );
  });
});

describe("parseBingDate", () => {
  it("applies negative offsets", () => {
    // 1746774000000 = 2025-05-09T07:00:00Z; -0700 → 2025-05-09 00:00 local
    expect(parseBingDate("/Date(1746774000000-0700)/")).toBe("2025-05-09");
  });

  it("handles missing offset", () => {
    expect(parseBingDate("/Date(1746774000000)/")).toBe("2025-05-09");
  });

  it("returns null for garbage", () => {
    expect(parseBingDate("2025-05-09")).toBeNull();
    expect(parseBingDate("/Date(abc)/")).toBeNull();
  });
});
