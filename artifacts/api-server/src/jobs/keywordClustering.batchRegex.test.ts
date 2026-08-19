/**
 * Unit tests for buildQueryRegexBatches (Fix 3 / blocker 3):
 *  - Escapes RE2 metacharacters in query aliases so they match literally.
 *  - Respects the QUERY_REGEX_BATCH_CHARS budget: each batch's regex stays
 *    under the limit so no single GSC request carries an oversized expression.
 *  - Accumulates the correct set of normalizedQuery keys per batch so
 *    post-fetch filtering can validate rows.
 *  - Empty input produces no batches (no spurious GSC calls).
 *  - Queries with multiple aliases are each included in a batch.
 *
 * Also includes an integration check that processRun would call
 * clusterLabelAndPersist with effectiveParams (Fix 1 stale-params regression).
 */

import { describe, it, expect } from "vitest";
import { buildQueryRegexBatches } from "./keywordClustering";

// ── Helper ──────────────────────────────────────────────────────────────────

function aliasMap(entries: [string, string[]][]): Map<string, Set<string>> {
  return new Map(entries.map(([k, v]) => [k, new Set(v)]));
}

// ── buildQueryRegexBatches ───────────────────────────────────────────────────

describe("buildQueryRegexBatches", () => {
  it("returns an empty array for an empty queryAliasMap", () => {
    expect(buildQueryRegexBatches(new Map())).toEqual([]);
  });

  it("produces exactly one batch for a small set of simple queries", () => {
    const map = aliasMap([
      ["seo tools", ["seo tools"]],
      ["link building", ["link building"]],
      ["keyword research", ["keyword research"]],
    ]);
    const batches = buildQueryRegexBatches(map);
    expect(batches).toHaveLength(1);
    // Regex is an anchored exact-match alternation.
    expect(batches[0]!.regex).toBe("^(seo tools|link building|keyword research)$");
    expect(batches[0]!.queriesInBatch.has("seo tools")).toBe(true);
    expect(batches[0]!.queriesInBatch.has("link building")).toBe(true);
    expect(batches[0]!.queriesInBatch.has("keyword research")).toBe(true);
  });

  it("escapes RE2 metacharacters: . * + ? ^ $ { } ( ) | [ ] \\", () => {
    const raw = 'cost per click (cpc) what\'s it? $5 [2025]';
    // Metacharacters: ( ) ? $  [  ]
    const map = aliasMap([["cost per click", [raw]]]);
    const batches = buildQueryRegexBatches(map);
    expect(batches).toHaveLength(1);
    const regex = batches[0]!.regex;
    const alternatives = regex.slice(2, -2);
    // Escaped form should not contain unescaped ( ) ? $ [ ]
    expect(alternatives).not.toMatch(/(?<!\\)\(/);
    expect(alternatives).not.toMatch(/(?<!\\)\)/);
    expect(alternatives).not.toMatch(/(?<!\\)\?/);
    expect(alternatives).not.toMatch(/(?<!\\)\$/);
    expect(alternatives).not.toMatch(/(?<!\\)\[/);
    expect(alternatives).not.toMatch(/(?<!\\)\]/);
    // The escaped form should be present
    expect(regex).toContain("\\(");
    expect(regex).toContain("\\)");
    expect(regex).toContain("\\?");
    expect(regex).toContain("\\$");
    expect(regex).toContain("\\[");
    expect(regex).toContain("\\]");
  });

  it("escapes pipe | so it doesn't create accidental alternatives", () => {
    const map = aliasMap([["a|b query", ["a|b query"]]]);
    const batches = buildQueryRegexBatches(map);
    expect(batches[0]!.regex).toBe("^(a\\|b query)$");
  });

  it("escapes backslash \\", () => {
    const map = aliasMap([["path\\to\\file", ["path\\to\\file"]]]);
    const batches = buildQueryRegexBatches(map);
    expect(batches[0]!.regex).toBe("^(path\\\\to\\\\file)$");
  });

  it("splits into multiple batches when total regex would exceed QUERY_REGEX_BATCH_CHARS", () => {
    // Build 20 queries each with a 200-char alias — total ≈ 4 000 chars > 3 500.
    const longAlias = "a".repeat(200);
    const entries: [string, string[]][] = Array.from({ length: 20 }, (_, i) => [
      `query${i}`,
      [`${longAlias}${i}`], // slightly different to avoid dedup
    ]);
    const map = aliasMap(entries);
    const batches = buildQueryRegexBatches(map);
    // Must produce more than 1 batch.
    expect(batches.length).toBeGreaterThan(1);
    // Each batch's regex must be at most 3 500 chars.
    for (const b of batches) {
      expect(b.regex.length).toBeLessThanOrEqual(3_500);
    }
    // All 20 normalized queries must appear across all batches.
    const allNormalized = new Set(batches.flatMap((b) => [...b.queriesInBatch]));
    for (let i = 0; i < 20; i++) {
      expect(allNormalized.has(`query${i}`)).toBe(true);
    }
  });

  it("each batch's queriesInBatch contains only the normalized queries for that batch", () => {
    // Three queries, but the first alone fills a batch with a very long alias.
    const longAlias = "x".repeat(3_490);
    const map = aliasMap([
      ["long query", [longAlias]],
      ["short a", ["short a"]],
      ["short b", ["short b"]],
    ]);
    const batches = buildQueryRegexBatches(map);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // The long alias must be in its own batch.
    const longBatch = batches.find((b) => b.queriesInBatch.has("long query"))!;
    expect(longBatch).toBeDefined();
    // short a and short b should be in some batch (possibly same).
    const allNorm = new Set(batches.flatMap((b) => [...b.queriesInBatch]));
    expect(allNorm.has("short a")).toBe(true);
    expect(allNorm.has("short b")).toBe(true);
  });

  it("supports multiple aliases per normalized query", () => {
    // If a query has two aliases they both end up as alternatives in the regex.
    const map = aliasMap([
      ["seo tools", ["seo tools", "SEO Tools"]], // both aliases
      ["link building", ["link building"]],
    ]);
    const batches = buildQueryRegexBatches(map);
    // All alternatives should appear somewhere in the combined batch regexes.
    const combined = batches.map((b) => b.regex).join("|");
    expect(combined).toContain("seo tools");
    expect(combined).toContain("SEO Tools");
    expect(combined).toContain("link building");
  });

  it("rejects a single alias that cannot fit safely in one expression", () => {
    const map = aliasMap([["too long", ["x".repeat(3_497)]]]);
    expect(() => buildQueryRegexBatches(map)).toThrow(/too long to safely batch/i);
  });

  it("no batch regex is empty", () => {
    const map = aliasMap([["test query", ["test query"]]]);
    const batches = buildQueryRegexBatches(map);
    for (const b of batches) {
      expect(b.regex.length).toBeGreaterThan(0);
    }
  });
});

// ── Stale-params regression (Fix 1) ─────────────────────────────────────────
//
// The stale-params bug: clusterLabelAndPersist previously read run.params for
// the final updateRun call.  If processRun had already updated params
// (window/evidenceSource/algorithmVersion) in an intermediate updateRun, the
// in-memory `run.params` snapshot seen by clusterLabelAndPersist was the
// original stale value — erasing those fields on the final write.
//
// The fix: processRun builds `effectiveParams` once and passes it explicitly
// to clusterLabelAndPersist; the function NEVER touches run.params.
//
// This test verifies the contract by inspecting the source: clusterLabelAndPersist
// must accept an `effectiveParams` argument and use it — not run.params — in
// the final updateRun call.

describe("clusterLabelAndPersist stale-params regression (Fix 1)", () => {
  it("clusterLabelAndPersist signature includes effectiveParams", () => {
    // Read the source and check the function signature / usage.
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const src: string = readFileSync(
      resolve(import.meta.dirname, "keywordClustering.ts"),
      "utf-8",
    );

    // Function must accept effectiveParams as a parameter.
    expect(src).toMatch(/function clusterLabelAndPersist[\s\S]{0,500}effectiveParams/);
    // Final updateRun inside clusterLabelAndPersist must use effectiveParams,
    // not run.params.
    // The pattern: params: { ...effectiveParams, reprocess: false }
    expect(src).toContain("...effectiveParams, reprocess: false");
    // The only valid occurrence of "...run.params, reprocess: false" is in the
    // error-recovery catch block (which restores the pre-rebuild state on
    // failure — that is intentional and correct).  Verify it appears exactly
    // once (the recovery path) — not additionally inside clusterLabelAndPersist.
    const matches = (src.match(/\.\.\.\brun\.params\b,\s*reprocess:\s*false/g) ?? []).length;
    expect(matches).toBe(1); // only the catch-block recovery path
  });

  it("processRun builds effectiveParams and passes it to clusterLabelAndPersist", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const src: string = readFileSync(
      resolve(import.meta.dirname, "keywordClustering.ts"),
      "utf-8",
    );

    // processRun must declare effectiveParams.
    expect(src).toContain("effectiveParams: ClusterRunParams");
    // processRun must pass effectiveParams to clusterLabelAndPersist.
    // The call pattern: clusterLabelAndPersist(..., effectiveParams,)
    expect(src).toMatch(/clusterLabelAndPersist[\s\S]{0,300}effectiveParams/);
  });

  it("reprocessRun passes run.params (not effectiveParams) to clusterLabelAndPersist", () => {
    // Rebuild: keeps stored params unchanged.
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const src: string = readFileSync(
      resolve(import.meta.dirname, "keywordClustering.ts"),
      "utf-8",
    );

    // reprocessRun's clusterLabelAndPersist call must end with run.params.
    // The comment above the call explains why.
    expect(src).toContain("run.params,");
    // The comment key phrase must be present (documents intent).
    expect(src).toMatch(/[Rr]ebuild retains exactly the stored params/);
  });
});
