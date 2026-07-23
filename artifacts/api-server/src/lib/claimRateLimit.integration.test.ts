import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db, claimAttemptsTable } from "@workspace/db";
import {
  bumpAndCheck,
  cleanupExpiredClaimAttempts,
  WINDOW_MS,
  MAX_STRIKES,
  MAX_LOCKOUT_MS,
} from "./claimRateLimit";

/**
 * Integration test (real Postgres via DATABASE_URL) for the escalating
 * claim-lockout upsert. The backoff logic lives entirely in SQL CASE
 * expressions, so it can only be verified against a real database.
 *
 * Time is simulated by rewinding the row's reset_at directly (the SQL only
 * compares reset_at to now()), so the test never sleeps.
 */

const PREFIX = `test-claim-${Date.now()}-${process.pid}`;
const MAX = 5; // budget under test (mirrors the per-user budget)

async function getRow(key: string) {
  const [row] = await db
    .select()
    .from(claimAttemptsTable)
    .where(eq(claimAttemptsTable.key, key));
  if (!row) throw new Error(`row ${key} missing`);
  return row;
}

/** Remaining window in ms (reset_at - now()) as seen by Postgres. */
async function remainingMs(key: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT extract(epoch FROM (reset_at - now())) * 1000 AS ms
        FROM claim_attempts WHERE key = ${key}`,
  );
  return Number((res.rows[0] as { ms: string | number }).ms);
}

/** Simulate the window having elapsed: rewind reset_at into the past. */
async function expireWindow(key: string) {
  await db
    .update(claimAttemptsTable)
    .set({ resetAt: sql`now() - interval '1 second'` })
    .where(eq(claimAttemptsTable.key, key));
}

/** Drive the key through one full window: MAX allowed + 1 over-budget. */
async function exhaustWindow(key: string) {
  for (let i = 0; i < MAX; i++) {
    expect((await bumpAndCheck(key, MAX)).limited).toBe(false);
  }
  expect((await bumpAndCheck(key, MAX)).limited).toBe(true);
}

// Windows should be within tolerance of the expected multiple of WINDOW_MS.
// Generous slack (5s) covers clock skew between calls, none of the asserted
// multiples are closer than 2x apart so this can never mask a wrong branch.
function expectWindow(ms: number, multiplier: number) {
  expect(ms).toBeGreaterThan(WINDOW_MS * multiplier - 5000);
  expect(ms).toBeLessThanOrEqual(WINDOW_MS * multiplier + 5000);
}

async function cleanup() {
  await db
    .delete(claimAttemptsTable)
    .where(like(claimAttemptsTable.key, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(cleanup);

describe("claim rate-limit escalating lockout", () => {
  it("allows up to the budget, then locks out with strike 1 and a doubled window", async () => {
    const key = `${PREFIX}-a`;

    for (let i = 1; i <= MAX; i++) {
      expect((await bumpAndCheck(key, MAX)).limited).toBe(false);
      const row = await getRow(key);
      expect(row.count).toBe(i);
      expect(row.strikes).toBe(0);
    }
    // Base window while under budget.
    expectWindow(await remainingMs(key), 1);

    // First over-budget attempt: strike 1, window extended to 2x base.
    expect((await bumpAndCheck(key, MAX)).limited).toBe(true);
    let row = await getRow(key);
    expect(row.count).toBe(MAX + 1);
    expect(row.strikes).toBe(1);
    expectWindow(await remainingMs(key), 2);

    // Further attempts during the lockout: still limited, but the strike
    // count and the window must NOT grow again (no self-extending lockout).
    const before = await remainingMs(key);
    expect((await bumpAndCheck(key, MAX)).limited).toBe(true);
    expect((await bumpAndCheck(key, MAX)).limited).toBe(true);
    row = await getRow(key);
    expect(row.count).toBe(MAX + 3);
    expect(row.strikes).toBe(1);
    const after = await remainingMs(key);
    expect(after).toBeLessThanOrEqual(before + 1000);
  });

  it("resets the counter after expiry WITHOUT resetting strikes, then doubles per exhausted window up to the 16x cap", async () => {
    const key = `${PREFIX}-b`;

    // Window 1: exhaust → strike 1.
    await exhaustWindow(key);
    expect((await getRow(key)).strikes).toBe(1);

    // Window expires: counter resets to 1, strikes persist, fresh base window.
    await expireWindow(key);
    expect((await bumpAndCheck(key, MAX)).limited).toBe(false);
    let row = await getRow(key);
    expect(row.count).toBe(1);
    expect(row.strikes).toBe(1);
    expectWindow(await remainingMs(key), 1);

    // Windows 2..5: each exhaustion bumps the strike and doubles the lockout
    // (2^strikes), capped at MAX_STRIKES (window multiplier capped at 16x).
    for (let strike = 2; strike <= MAX_STRIKES + 2; strike++) {
      // finish exhausting the current window (1 attempt already used)
      for (let i = 1; i < MAX; i++) {
        expect((await bumpAndCheck(key, MAX)).limited).toBe(false);
      }
      expect((await bumpAndCheck(key, MAX)).limited).toBe(true);
      row = await getRow(key);
      const expectedStrikes = Math.min(strike, MAX_STRIKES);
      expect(row.strikes).toBe(expectedStrikes);
      expectWindow(
        await remainingMs(key),
        Math.min(2 ** expectedStrikes, 2 ** MAX_STRIKES),
      );

      await expireWindow(key);
      expect((await bumpAndCheck(key, MAX)).limited).toBe(false);
      row = await getRow(key);
      expect(row.count).toBe(1);
      expect(row.strikes).toBe(expectedStrikes);
    }

    // After more exhausted windows than MAX_STRIKES, strikes stay capped at 4
    // and the lockout stays at 16x base (4h for the 15m base window).
    expect((await getRow(key)).strikes).toBe(MAX_STRIKES);
  });
});

describe("claim rate-limit cleanup (strike-history decay)", () => {
  /** Seed a row directly with reset_at offset from now() by `offsetMs`. */
  async function seedRow(key: string, offsetMs: number, strikes = MAX_STRIKES) {
    await db.insert(claimAttemptsTable).values({
      key,
      count: 1,
      strikes,
      resetAt: sql`now() + make_interval(secs => ${offsetMs / 1000})`,
    });
  }

  async function rowExists(key: string): Promise<boolean> {
    const rows = await db
      .select({ key: claimAttemptsTable.key })
      .from(claimAttemptsTable)
      .where(eq(claimAttemptsTable.key, key));
    return rows.length > 0;
  }

  it("deletes only rows expired for longer than MAX_LOCKOUT_MS, keeping recent strike history", async () => {
    const HOUR = 60 * 60 * 1000;
    // Sanity-check the constant this test guards: 16x the 15m base = 4h.
    expect(MAX_LOCKOUT_MS).toBe(4 * HOUR);

    const keep = [
      // Active window (reset_at in the future) — must never be deleted.
      { key: `${PREFIX}-cln-active`, offset: +WINDOW_MS },
      // Just expired — strikes must survive so the next window escalates.
      { key: `${PREFIX}-cln-just-expired`, offset: -1000 },
      // Expired 1h ago — still within the 4h retention.
      { key: `${PREFIX}-cln-1h`, offset: -HOUR },
      // Expired just under the max lockout — boundary row, still kept.
      { key: `${PREFIX}-cln-boundary`, offset: -(MAX_LOCKOUT_MS - 60 * 1000) },
    ];
    const drop = [
      // Expired just past the max lockout — quiet period over, forget it.
      { key: `${PREFIX}-cln-past`, offset: -(MAX_LOCKOUT_MS + 60 * 1000) },
      // Expired days ago — must be deleted (table growth).
      { key: `${PREFIX}-cln-ancient`, offset: -(7 * 24 * HOUR) },
    ];
    for (const r of [...keep, ...drop]) await seedRow(r.key, r.offset);

    await cleanupExpiredClaimAttempts();

    for (const r of keep) {
      expect(await rowExists(r.key), `${r.key} should be kept`).toBe(true);
    }
    for (const r of drop) {
      expect(await rowExists(r.key), `${r.key} should be deleted`).toBe(false);
    }

    // The surviving just-expired row must retain its strikes so a returning
    // attacker resumes at the escalated lockout, not a fresh 15m window.
    const survivor = await getRow(`${PREFIX}-cln-just-expired`);
    expect(survivor.strikes).toBe(MAX_STRIKES);
  });
});
