/**
 * checkSpamTldFreshness.ts
 *
 * Weekly cron that cross-references the authoritative spam-TLD set (from the
 * shared `@workspace/spam-tlds` package) against two public reference feeds
 * and logs structured WARN entries for any TLD that looks high-abuse but is
 * NOT yet in our list.
 *
 * This implements the "silent staleness" guard described in
 * `lib/spam-tlds/src/index.ts`: it surfaces candidates to the operator —
 * it NEVER auto-adds TLDs. Every addition still requires the evidence check
 * described in the HOW TO ADD A TLD block of that file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REFERENCE SOURCES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Source 1 — IANA full TLD registry (plain text, one TLD per line):
 *   https://data.iana.org/TLD/tlds-alpha-by-domain.txt
 *   Maintained by ICANN; used as two signals:
 *     a) Any TLD in SPAM_TLDS that no longer appears in the IANA list is
 *        flagged as a potential removal candidate (the TLD was de-delegated).
 *     b) New TLDs delegated since the list was last reviewed are not directly
 *        flagged here — Source 2 catches newly-abused additions.
 *
 * Source 2 — Disposable email domain list (plain text, one domain per line):
 *   https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf
 *   Maintained by the open-source community; spam operators reuse the same
 *   TLDs for disposable email, phishing, and link spam. TLDs that appear
 *   disproportionately often in this list (≥ MIN_DISPOSABLE_FREQUENCY times,
 *   or ≥ MIN_DISPOSABLE_FRACTION of all entries) are flagged as candidates
 *   when they are NOT already in SPAM_TLDS.
 *
 * If either source is unreachable the other still runs. Both failing is
 * logged as a warning but does NOT throw (the cron must not crash the server).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CADENCE & ALERTING
 * ─────────────────────────────────────────────────────────────────────────
 * Scheduled: Wednesday 08:00 UTC weekly (see scheduler.ts).
 *
 * Log entries produced by this cron:
 *
 *   "spam-tld-freshness: candidate TLD not in local list"  (warn)
 *     tld     : string — the candidate TLD
 *     sources : string[] — which sources flagged it
 *     details : object — source-specific metadata (count, fraction, etc.)
 *
 *   "spam-tld-freshness: TLD in local list no longer in IANA registry"  (warn)
 *     tld     : string — the TLD that may have been de-delegated
 *
 *   "spam-tld-freshness: freshness check complete"  (info or warn)
 *     candidateCount : number
 *     staleCount     : number — SPAM_TLDS entries absent from IANA
 *     sourcesReachable : string[]
 *
 * Search your log aggregator for  msg:"spam-tld-freshness"  to find all events.
 */

import { SPAM_TLDS } from "@workspace/spam-tlds";
import { logger } from "../lib/logger";

const LOG_PREFIX = "spam-tld-freshness";

// ── Source 1: IANA full TLD registry ─────────────────────────────────────────
export const IANA_TLD_URL = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt";

// ── Source 2: Disposable email domain list ────────────────────────────────────
// Spam operators use the same TLDs for disposable email and link spam.
// A TLD appearing ≥ MIN_DISPOSABLE_FREQUENCY times (or ≥ MIN_DISPOSABLE_FRACTION
// of all entries) in this list is a candidate worth reviewing.
export const DISPOSABLE_DOMAINS_URL =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf";

/** Minimum number of appearances in the disposable list to flag as a candidate. */
export const MIN_DISPOSABLE_FREQUENCY = 5;
/** Minimum fraction (0–1) of entries with the TLD to flag as a candidate. */
export const MIN_DISPOSABLE_FRACTION = 0.005; // 0.5 %

/**
 * Fetch the IANA full TLD registry and return the set of registered TLD strings
 * (lowercase, no leading dot).  Returns null on any failure.
 */
export async function fetchIanaTlds(fetcher = fetch): Promise<Set<string> | null> {
  try {
    const res = await fetcher(IANA_TLD_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "SpamTldFreshnessBot/1.0 (internal monitoring)" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, `${LOG_PREFIX}: IANA TLD list returned non-OK status`);
      return null;
    }
    const text = await res.text();
    const tlds = text
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#") && /^[a-z0-9-]{2,63}$/.test(l));
    if (tlds.length < 100) {
      // IANA list has >1000 TLDs; far fewer suggests a parse failure.
      logger.warn(
        { parsed: tlds.length },
        `${LOG_PREFIX}: IANA list parsed unexpectedly few TLDs — check source format`,
      );
      return null;
    }
    return new Set(tlds);
  } catch (err) {
    logger.warn({ err }, `${LOG_PREFIX}: failed to fetch IANA TLD registry`);
    return null;
  }
}

/**
 * Fetch the disposable email domain list and return a frequency map of TLDs
 * (lowercase, no leading dot) → occurrence count.
 * Returns null on any failure.
 */
export async function fetchDisposableDomainTldFrequency(
  fetcher = fetch,
): Promise<Map<string, number> | null> {
  try {
    const res = await fetcher(DISPOSABLE_DOMAINS_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "SpamTldFreshnessBot/1.0 (internal monitoring)" },
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        `${LOG_PREFIX}: disposable email domain list returned non-OK status`,
      );
      return null;
    }
    const text = await res.text();
    const freq = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) {
      const domain = line.trim().toLowerCase();
      if (!domain || domain.startsWith("#")) continue;
      // Extract TLD: last label of the domain (e.g. "mailinator.com" → "com").
      const tld = domain.split(".").at(-1);
      if (tld && /^[a-z0-9-]{2,63}$/.test(tld)) {
        freq.set(tld, (freq.get(tld) ?? 0) + 1);
      }
    }
    if (freq.size === 0) {
      logger.warn(`${LOG_PREFIX}: disposable domain list parsed 0 TLDs — check source format`);
      return null;
    }
    return freq;
  } catch (err) {
    logger.warn({ err }, `${LOG_PREFIX}: failed to fetch disposable email domain list`);
    return null;
  }
}

/**
 * Run the spam-TLD freshness check.
 *
 * 1. Load SPAM_TLDS from the shared @workspace/spam-tlds package.
 * 2. Fetch the IANA TLD registry; flag any SPAM_TLDS entries no longer present
 *    (potential removal candidates).
 * 3. Fetch the disposable email domain list; compute per-TLD frequency; flag
 *    high-frequency TLDs absent from SPAM_TLDS as addition candidates.
 * 4. Log one structured WARN per candidate or stale entry.
 */
export async function runCheckSpamTldFreshness(fetcher = fetch): Promise<void> {
  logger.info({ count: SPAM_TLDS.size }, `${LOG_PREFIX}: starting weekly freshness check`);

  // Fetch both sources in parallel.
  const [ianaTlds, disposableFreq] = await Promise.all([
    fetchIanaTlds(fetcher),
    fetchDisposableDomainTldFrequency(fetcher),
  ]);

  const sourcesReachable: string[] = [];
  if (ianaTlds !== null) sourcesReachable.push("iana");
  if (disposableFreq !== null) sourcesReachable.push("disposable-email-domains");

  if (sourcesReachable.length === 0) {
    logger.warn(
      `${LOG_PREFIX}: all reference sources unreachable — check network or source URLs`,
    );
    return;
  }

  // ── Signal 1: SPAM_TLDS entries absent from IANA (possible removal candidates) ──
  const staleTlds: string[] = [];
  if (ianaTlds !== null) {
    for (const tld of SPAM_TLDS) {
      if (!ianaTlds.has(tld)) {
        staleTlds.push(tld);
        logger.warn(
          { tld },
          `${LOG_PREFIX}: TLD in local list no longer in IANA registry — review for removal`,
        );
      }
    }
  }

  // ── Signal 2: High-frequency TLDs in disposable list absent from SPAM_TLDS ──
  const addCandidates: Array<{ tld: string; count: number; fraction: number }> = [];
  if (disposableFreq !== null) {
    const total = [...disposableFreq.values()].reduce((s, n) => s + n, 0);
    for (const [tld, count] of disposableFreq) {
      if (SPAM_TLDS.has(tld)) continue;
      const fraction = count / total;
      if (count >= MIN_DISPOSABLE_FREQUENCY || fraction >= MIN_DISPOSABLE_FRACTION) {
        addCandidates.push({ tld, count, fraction });
      }
    }
    // Sort: strongest signal first (highest fraction, then count).
    addCandidates.sort(
      (a, b) => b.fraction - a.fraction || b.count - a.count || a.tld.localeCompare(b.tld),
    );
    for (const { tld, count, fraction } of addCandidates) {
      logger.warn(
        {
          tld,
          sources: ["disposable-email-domains"],
          details: { count, fraction: +fraction.toFixed(5) },
        },
        `${LOG_PREFIX}: candidate TLD not in local list — review evidence before adding`,
      );
    }
  }

  const totalCandidates = addCandidates.length;
  const logFn = totalCandidates > 0 || staleTlds.length > 0 ? logger.warn : logger.info;
  logFn.call(logger, {
    candidateCount: totalCandidates,
    staleCount: staleTlds.length,
    sourcesReachable,
    localCount: SPAM_TLDS.size,
    ...(totalCandidates > 0 || staleTlds.length > 0
      ? { actionRequired: "Review each entry against the evidence policy in lib/spam-tlds/src/index.ts." }
      : {}),
  }, `${LOG_PREFIX}: freshness check complete`);
}
