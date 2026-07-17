import { logger } from "./logger";

// Substrings (matched case-insensitively) that mark a transient
// connection/auth failure — the kind that drops a single query mid-run on
// serverless Postgres but recovers on the next attempt. These are matched
// against the Drizzle-wrapped message (which appends the driver cause) as well
// as the underlying cause chain.
const TRANSIENT_PATTERNS = [
  "connection terminated",
  "authentication timed out",
  "timeout exceeded when trying to connect",
  "terminating connection",
  "server closed the connection",
  "connection ended",
  "connection reset",
  "socket disconnected",
  "socket hang up",
  "ssl connection has been closed",
  "eai_again",
  "econnreset",
  "epipe",
  "etimedout",
  "econnrefused",
];

// Postgres SQLSTATE codes for connection-level failures (class 08 + admin
// shutdown / cannot-connect-now). Client-side pool errors usually have no code,
// which is why message matching above is the primary signal.
const TRANSIENT_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
]);

function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (TRANSIENT_PATTERNS.some((p) => msg.includes(p))) return true;
  if (e.cause && e.cause !== err) return isTransientDbError(e.cause);
  return false;
}

export interface DbRetryOptions {
  /** Number of retries AFTER the first attempt (default 3 → up to 4 tries). */
  retries?: number;
  /** Base backoff in ms; doubles each attempt (default 500 → 0.5s, 1s, 2s). */
  baseDelayMs?: number;
  /** Label for logs so a noisy step can be identified. */
  label?: string;
}

/**
 * Run an idempotent DB operation, retrying only on transient connection/auth
 * errors with exponential backoff. Non-transient errors (bad SQL, constraint
 * violations, etc.) are re-thrown immediately. Only wrap idempotent work —
 * SELECTs and upserts (onConflict*) are safe; plain INSERTs are not, because a
 * dropped ack after a committed write would duplicate the row on retry.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: DbRetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientDbError(err)) throw err;
      const delayMs = baseDelayMs * 2 ** attempt;
      logger.warn(
        { err, attempt: attempt + 1, maxRetries: retries, delayMs, label: opts.label },
        "Transient DB error; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
