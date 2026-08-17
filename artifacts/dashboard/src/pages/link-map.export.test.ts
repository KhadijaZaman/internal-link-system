/**
 * Tests for buildLinksCsv / GLOBAL_TABLE_CAP export behaviour.
 *
 * Key invariants verified:
 *  1. The CSV output contains every row in the supplied array, even when the
 *     array is larger than GLOBAL_TABLE_CAP (800). The table component caps
 *     visible rows at 800, but the export must never apply that cap.
 *  2. Anchor text that contains commas or double-quotes is correctly quoted
 *     according to RFC 4180 so the CSV opens without corruption in
 *     Excel / Google Sheets.
 */

import { describe, expect, it } from "vitest";
import { buildLinksCsv, GLOBAL_TABLE_CAP } from "./link-map";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 CSV parser — returns a 2-D array of unquoted cell strings. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

type LinkRow = {
  source: string;
  target: string;
  position: string;
  links: number;
  anchors: Set<string>;
};

function makeRow(i: number, anchors: string[] = ["anchor"]): LinkRow {
  return {
    source: `/page-${i}/`,
    target: `/target-${i}/`,
    position: "content",
    links: 1,
    anchors: new Set(anchors),
  };
}

// ---------------------------------------------------------------------------
// Row-count: export must not be capped at GLOBAL_TABLE_CAP
// ---------------------------------------------------------------------------

describe("buildLinksCsv row count", () => {
  it("exports all rows when count equals GLOBAL_TABLE_CAP", () => {
    const rows = Array.from({ length: GLOBAL_TABLE_CAP }, (_, i) => makeRow(i));
    const parsed = parseCsv(buildLinksCsv(rows));
    // +1 for the header row
    expect(parsed).toHaveLength(GLOBAL_TABLE_CAP + 1);
  });

  it("exports all rows when count exceeds GLOBAL_TABLE_CAP", () => {
    const total = GLOBAL_TABLE_CAP + 200; // 1 000 rows
    const rows = Array.from({ length: total }, (_, i) => makeRow(i));
    const parsed = parseCsv(buildLinksCsv(rows));
    expect(parsed).toHaveLength(total + 1); // all data rows + header
  });

  it("includes the correct source URL in every data row beyond the cap", () => {
    const total = GLOBAL_TABLE_CAP + 5;
    const rows = Array.from({ length: total }, (_, i) => makeRow(i));
    const parsed = parseCsv(buildLinksCsv(rows));
    // Last data row (index total in parsed, because [0] is the header)
    const lastDataRow = parsed[total]!;
    expect(lastDataRow[0]).toBe(`/page-${total - 1}/`);
  });

  it("produces a header row with the expected column names", () => {
    const parsed = parseCsv(buildLinksCsv([makeRow(0)]));
    expect(parsed[0]).toEqual([
      "Source",
      "Destination",
      "Position",
      "Links",
      "Anchor text",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Anchor text: special characters must survive the CSV round-trip correctly
// ---------------------------------------------------------------------------

describe("buildLinksCsv anchor text escaping", () => {
  it("wraps anchor text containing a comma in double quotes", () => {
    const rows = [makeRow(0, ["buy now, save 20%"])];
    const parsed = parseCsv(buildLinksCsv(rows));
    // Column index 4 is "Anchor text"
    expect(parsed[1]![4]).toBe("buy now, save 20%");
  });

  it("escapes double-quotes inside anchor text (RFC 4180 doubling)", () => {
    const rows = [makeRow(0, [`click "here" to continue`])];
    const parsed = parseCsv(buildLinksCsv(rows));
    expect(parsed[1]![4]).toBe(`click "here" to continue`);
  });

  it("handles anchor text with both a comma and a double-quote", () => {
    const rows = [makeRow(0, [`"best deal", guaranteed`])];
    const parsed = parseCsv(buildLinksCsv(rows));
    expect(parsed[1]![4]).toBe(`"best deal", guaranteed`);
  });

  it("joins multiple anchor texts with ' · ' and still escapes commas", () => {
    const rows = [makeRow(0, ["link one, extra", "link two"])];
    const parsed = parseCsv(buildLinksCsv(rows));
    // The two anchors are joined; the combined string contains a comma
    const anchorCell = parsed[1]![4]!;
    expect(anchorCell).toContain("link one, extra");
    expect(anchorCell).toContain("link two");
  });

  it("neutralises a formula-injection anchor that starts with =", () => {
    const rows = [makeRow(0, [`=HYPERLINK("http://evil.com","click")`])];
    const parsed = parseCsv(buildLinksCsv(rows));
    const anchorCell = parsed[1]![4]!;
    // cleanCell prepends a single quote — it must not start with =
    expect(anchorCell).not.toMatch(/^=/);
    expect(anchorCell.startsWith("'")).toBe(true);
  });

  it("passes through plain anchor text unchanged", () => {
    const rows = [makeRow(0, ["learn more"])];
    const parsed = parseCsv(buildLinksCsv(rows));
    expect(parsed[1]![4]).toBe("learn more");
  });
});
