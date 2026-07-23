import { db, claimAttemptsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Durable rate-limit counters for the one-time legacy-site claim endpoint,
 * with escalating (exponential-backoff) lockouts. Extracted from the sites
 * route so the CASE logic in the upsert can be integration-tested directly.
 */

export const WINDOW_MS = 15 * 60 * 1000;
// Exponential backoff: each exhausted window doubles the next lockout,
// capped at 16x the base window (15m → 30m → 1h → 2h → 4h).
export const MAX_STRIKES = 4;
export const MAX_LOCKOUT_MS = WINDOW_MS * 2 ** MAX_STRIKES;

// Atomically bump a counter row in Postgres and return whether it exceeded
// its budget. The counters live in the claim_attempts table so restarts and
// Autoscale instance recycling never reset the budget. When the fixed window
// has elapsed the counter resets to 1 and a fresh window begins.
// Exponential backoff on top of the fixed window: the first time an attempt
// pushes the counter past its budget, the key earns a "strike" and the
// current window is extended to WINDOW_MS * 2^strikes (capped at
// MAX_LOCKOUT_MS). Further attempts during the lockout do NOT extend it
// again (count is already past max+1), so an attacker cannot lock a shared
// key forever, but each fully exhausted window doubles the next lockout.
// Strikes persist in the same claim_attempts row across restarts.
export async function bumpAndCheck(
  key: string,
  max: number,
): Promise<{ limited: boolean; resetAt: Date }> {
  const rows = await db
    .insert(claimAttemptsTable)
    .values({
      key,
      count: 1,
      strikes: 0,
      resetAt: sql`now() + make_interval(secs => ${WINDOW_MS / 1000})`,
    })
    .onConflictDoUpdate({
      target: claimAttemptsTable.key,
      set: {
        count: sql`CASE WHEN ${claimAttemptsTable.resetAt} <= now() THEN 1 ELSE ${claimAttemptsTable.count} + 1 END`,
        strikes: sql`CASE
          WHEN ${claimAttemptsTable.resetAt} <= now() THEN ${claimAttemptsTable.strikes}
          WHEN ${claimAttemptsTable.count} + 1 = ${max + 1} THEN LEAST(${claimAttemptsTable.strikes} + 1, ${MAX_STRIKES})
          ELSE ${claimAttemptsTable.strikes}
        END`,
        resetAt: sql`CASE
          WHEN ${claimAttemptsTable.resetAt} <= now() THEN now() + make_interval(secs => ${WINDOW_MS / 1000})
          WHEN ${claimAttemptsTable.count} + 1 = ${max + 1} THEN now() + make_interval(secs => ${WINDOW_MS / 1000} * LEAST(POWER(2, ${claimAttemptsTable.strikes} + 1), ${2 ** MAX_STRIKES}))
          ELSE ${claimAttemptsTable.resetAt}
        END`,
      },
    })
    .returning({
      count: claimAttemptsTable.count,
      resetAt: claimAttemptsTable.resetAt,
    });
  return { limited: rows[0].count > max, resetAt: rows[0].resetAt };
}
