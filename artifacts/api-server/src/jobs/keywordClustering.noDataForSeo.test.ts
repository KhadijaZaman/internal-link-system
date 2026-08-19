/**
 * Architectural guard: keywordClustering.ts must never import from the
 * DataForSEO integration or call its SERP task functions.
 *
 * Fresh keyword clustering uses GSC page evidence only — DataForSEO SERP
 * calls add latency, cost, and a paid-budget dependency that is incompatible
 * with the current GSC-page design.  This test catches any accidental
 * re-introduction of that dependency at import or call-site level.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const JOB_PATH = resolve(
  import.meta.dirname,
  "keywordClustering.ts",
);

const source = readFileSync(JOB_PATH, "utf-8");

describe("keywordClustering.ts — DataForSEO architectural guard", () => {
  // ── No DataForSEO import ─────────────────────────────────────────────────

  it("does not import from '../integrations/dataforseo'", () => {
    // Catches both static `import` and dynamic `import(...)` forms.
    expect(source).not.toMatch(/['"]\.\.\/integrations\/dataforseo['"]/);
  });

  it("does not import from any dataforseo path variant", () => {
    // Catches deeper paths like '../../integrations/dataforseo' or
    // '@workspace/dataforseo' if the integration were ever extracted.
    // We test only import statements (lines starting with 'import'),
    // not string literals (e.g. error messages may mention "DataForSEO").
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n")
      .toLowerCase();
    expect(importLines).not.toMatch(/dataforseo/);
  });

  // ── No SERP task call-sites ──────────────────────────────────────────────

  it("does not call postSerpTasks()", () => {
    expect(source).not.toMatch(/\bpostSerpTasks\s*\(/);
  });

  it("does not reference postSerpTasks at all (not imported, not called)", () => {
    expect(source).not.toContain("postSerpTasks");
  });

  it("does not call fetchSerpTaskResult()", () => {
    expect(source).not.toMatch(/\bfetchSerpTaskResult\s*\(/);
  });

  it("does not reference fetchSerpTaskResult at all", () => {
    expect(source).not.toContain("fetchSerpTaskResult");
  });

  // ── No SERP poll / wait infrastructure ──────────────────────────────────

  it("does not define a SERP_INITIAL_WAIT_MS or SERP_SWEEP_INTERVAL_MS constant", () => {
    expect(source).not.toContain("SERP_INITIAL_WAIT_MS");
    expect(source).not.toContain("SERP_SWEEP_INTERVAL_MS");
  });

  it("does not define a SERP_TIMEOUT_MS constant", () => {
    expect(source).not.toContain("SERP_TIMEOUT_MS");
  });

  // ── Uses GSC-page path ───────────────────────────────────────────────────
  // Positive smoke-checks so the test fails loudly if the whole file is
  // accidentally replaced with an empty stub.

  it("imports queryGscQueryPage from the GSC integration", () => {
    expect(source).toContain("queryGscQueryPage");
  });

  it("imports selectEligibleQueries from the clustering service", () => {
    expect(source).toContain("selectEligibleQueries");
  });

  it("sets evidenceSource to 'gsc_page' when persisting run params", () => {
    expect(source).toContain("evidenceSource");
    expect(source).toContain("gsc_page");
  });
});
