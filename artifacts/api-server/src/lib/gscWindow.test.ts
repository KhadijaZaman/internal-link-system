/**
 * Unit tests for gscWindow helpers.
 *
 * Scenarios:
 *  1. isoDateOffsetFrom – basic offset arithmetic
 *  2. loadGscWindow – no app_state rows → both dates null
 *  3. loadGscWindow – app_state rows present → returns stored dates
 *  4. persistGscWindow – writes the correct keys to app_state
 *  5. Skip-path safety – loadGscWindow returns prior values when persistGscWindow
 *     is NOT called (simulating a GSC-disconnected no-op job run)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock (operators become identity tokens) ────────────────────

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ _eq: val }),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

// In-memory store keyed by app_state key.
let store: Record<string, string> = {};

// Capture upsert calls so we can assert they write the correct keys.
const upsertCalls: Array<{ values: Array<{ key: string; value: string }> }> = [];

const selectChain = {
  from(_t: unknown) { return this; },
  where(cond: { _eq: string }) {
    const row = store[cond._eq];
    return {
      limit(_n: number) {
        return Promise.resolve(row != null ? [{ value: row }] : []);
      },
    };
  },
};

const insertChain = {
  values(vals: Array<{ key: string; value: string }>) {
    upsertCalls.push({ values: vals });
    return {
      onConflictDoUpdate(_opts: unknown) {
        // Apply the upsert to the in-memory store.
        for (const v of vals) store[v.key] = v.value;
        return Promise.resolve();
      },
    };
  },
};

vi.mock("@workspace/db", () => ({
  db: {
    select: (_cols?: unknown) => selectChain,
    insert: (_table: unknown) => insertChain,
  },
  appStateTable: {
    key: "key",
    value: "value",
  },
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { isoDateOffsetFrom, loadGscWindow, persistGscWindow, gscWindowStartKey, gscWindowEndKey } from "./gscWindow";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("isoDateOffsetFrom", () => {
  it("returns YYYY-MM-DD 9 days before the input", () => {
    expect(isoDateOffsetFrom(new Date("2026-08-12T00:00:00Z"), 9)).toBe("2026-08-03");
  });

  it("returns YYYY-MM-DD 3 days before the input", () => {
    expect(isoDateOffsetFrom(new Date("2026-08-12T00:00:00Z"), 3)).toBe("2026-08-09");
  });

  it("handles month boundary correctly", () => {
    expect(isoDateOffsetFrom(new Date("2026-08-03T00:00:00Z"), 9)).toBe("2026-07-25");
  });
});

describe("loadGscWindow", () => {
  beforeEach(() => {
    store = {};
    upsertCalls.length = 0;
  });

  it("returns null dates when no app_state rows exist (job never ran)", async () => {
    const result = await loadGscWindow(1);
    expect(result).toEqual({ gscWindowStart: null, gscWindowEnd: null });
  });

  it("returns stored dates when app_state rows are present", async () => {
    store[gscWindowStartKey(1)] = "2026-08-03";
    store[gscWindowEndKey(1)] = "2026-08-09";
    const result = await loadGscWindow(1);
    expect(result).toEqual({ gscWindowStart: "2026-08-03", gscWindowEnd: "2026-08-09" });
  });

  it("returns null when only the start key is present (partial state)", async () => {
    store[gscWindowStartKey(1)] = "2026-08-03";
    // no end key
    const result = await loadGscWindow(1);
    expect(result).toEqual({ gscWindowStart: "2026-08-03", gscWindowEnd: null });
  });

  it("isolates per-site: site 2 dates do not bleed into site 1 result", async () => {
    store[gscWindowStartKey(2)] = "2026-07-01";
    store[gscWindowEndKey(2)] = "2026-07-07";
    const result = await loadGscWindow(1);
    expect(result).toEqual({ gscWindowStart: null, gscWindowEnd: null });
  });
});

describe("persistGscWindow", () => {
  beforeEach(() => {
    store = {};
    upsertCalls.length = 0;
  });

  it("writes the correct start and end keys to app_state", async () => {
    await persistGscWindow(42, "2026-08-03", "2026-08-09");
    expect(store[gscWindowStartKey(42)]).toBe("2026-08-03");
    expect(store[gscWindowEndKey(42)]).toBe("2026-08-09");
  });

  it("upserts both values in a single insert call", async () => {
    await persistGscWindow(5, "2026-08-03", "2026-08-09");
    expect(upsertCalls).toHaveLength(1);
    const keys = upsertCalls[0]!.values.map((v) => v.key);
    expect(keys).toContain(gscWindowStartKey(5));
    expect(keys).toContain(gscWindowEndKey(5));
  });
});

describe("skip-path safety", () => {
  beforeEach(() => {
    store = {};
    upsertCalls.length = 0;
  });

  it("retains prior window when persistGscWindow is never called (GSC disconnected skip)", async () => {
    // Simulate a prior successful sync that persisted a window.
    store[gscWindowStartKey(7)] = "2026-07-21";
    store[gscWindowEndKey(7)] = "2026-07-27";

    // A GSC-disconnected job run returns early WITHOUT calling persistGscWindow.
    // loadGscWindow must still return the prior accurate window, not null.
    const result = await loadGscWindow(7);
    expect(result).toEqual({ gscWindowStart: "2026-07-21", gscWindowEnd: "2026-07-27" });
    expect(upsertCalls).toHaveLength(0); // persistGscWindow was never called
  });
});
