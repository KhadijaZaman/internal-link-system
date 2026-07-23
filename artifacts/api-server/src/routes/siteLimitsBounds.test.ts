import { describe, it, expect } from "vitest";
import { UpdateSiteLimitsBody } from "@workspace/api-zod";

/**
 * The per-site spend-limit bounds are part of the API contract (OpenAPI →
 * generated Zod). These tests pin them: if someone edits the spec bounds,
 * LIMIT_BOUNDS in routes/sites.ts must move in lockstep, and this file makes
 * the contract's actual behavior explicit.
 */

const BOUNDS = {
  maxCrawlPages: { min: 50, max: 20000 },
  maxLlmCallsPerRun: { min: 10, max: 5000 },
  maxSerpQueriesPerRun: { min: 5, max: 2000 },
} as const;

type Key = keyof typeof BOUNDS;
const KEYS = Object.keys(BOUNDS) as Key[];

describe("UpdateSiteLimitsBody bounds", () => {
  for (const key of KEYS) {
    const { min, max } = BOUNDS[key];

    it(`${key}: accepts min (${min}) and max (${max})`, () => {
      expect(UpdateSiteLimitsBody.safeParse({ [key]: min }).success).toBe(true);
      expect(UpdateSiteLimitsBody.safeParse({ [key]: max }).success).toBe(true);
    });

    it(`${key}: rejects below min and above max`, () => {
      expect(UpdateSiteLimitsBody.safeParse({ [key]: min - 1 }).success).toBe(false);
      expect(UpdateSiteLimitsBody.safeParse({ [key]: max + 1 }).success).toBe(false);
    });

    it(`${key}: non-integers pass the schema (route drops them via Number.isInteger)`, () => {
      // The generated Zod schema only enforces min/max; integer-ness is
      // enforced by the PATCH handler, which ignores non-integer values.
      expect(UpdateSiteLimitsBody.safeParse({ [key]: min + 0.5 }).success).toBe(true);
    });

    it(`${key}: rejects wrong types`, () => {
      expect(UpdateSiteLimitsBody.safeParse({ [key]: String(min) }).success).toBe(false);
      expect(UpdateSiteLimitsBody.safeParse({ [key]: null }).success).toBe(false);
    });
  }

  it("accepts a partial body (single field)", () => {
    const parsed = UpdateSiteLimitsBody.safeParse({ maxCrawlPages: 100 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxLlmCallsPerRun).toBeUndefined();
      expect(parsed.data.maxSerpQueriesPerRun).toBeUndefined();
    }
  });

  it("accepts all three fields together", () => {
    expect(
      UpdateSiteLimitsBody.safeParse({
        maxCrawlPages: 2000,
        maxLlmCallsPerRun: 500,
        maxSerpQueriesPerRun: 100,
      }).success,
    ).toBe(true);
  });

  it("rejects negative and zero values on every field", () => {
    for (const key of KEYS) {
      expect(UpdateSiteLimitsBody.safeParse({ [key]: 0 }).success).toBe(false);
      expect(UpdateSiteLimitsBody.safeParse({ [key]: -10 }).success).toBe(false);
    }
  });
});
