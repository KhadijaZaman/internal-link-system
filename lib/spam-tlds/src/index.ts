/**
 * Authoritative list of TLDs disproportionately represented in link-spam campaigns.
 *
 * This package is the single source of truth for suspicious-TLD detection used by
 * the toxicity scorer and the disavow export in `@workspace/dashboard`, and by the
 * weekly freshness-check cron in `@workspace/api-server`.
 *
 * Edit ONLY this file when adding or removing TLDs — never edit the consuming
 * packages directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A TLD
 * ─────────────────────────────────────────────────────────────────────────────
 * Before adding, require at least ONE of the following pieces of evidence:
 *   • A published Google spam report or Search Central blog post naming the TLD.
 *   • A credible third-party study (Ahrefs, SEMrush, Spamhaus) showing the TLD
 *     in the top-20 most-abused extensions.
 *   • Pattern observed across ≥ 3 unrelated client disavow exports in the same
 *     quarter, with the spam link share > 30 % for that TLD.
 *
 * Steps:
 *   1. Add the lowercase TLD string to the `SPAM_TLDS` array below.
 *   2. Add a short inline comment referencing the evidence source and date.
 *   3. Run `pnpm --filter @workspace/dashboard test` and confirm all tests pass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTOMATED FRESHNESS CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 * A weekly cron in the API server cross-references this list against two
 * public spam-TLD feeds and logs a structured WARN for every TLD that the
 * feeds flag as high-abuse but that is not yet present here:
 *
 *   Source file : artifacts/api-server/src/jobs/checkSpamTldFreshness.ts
 *   Schedule    : Wednesday 08:00 UTC (registered in scheduler.ts)
 *   Log filter  : msg:"spam-tld-freshness"
 *   Reference 1 : https://www.spamhaus.org/statistics/tlds/
 *   Reference 2 : https://github.com/nicktacular/surbl-domains-and-tlds
 *
 * The cron NEVER auto-adds TLDs. Each candidate surfaces as a WARN log entry
 * with the TLD string and the source(s) that flagged it. An operator then
 * decides whether the evidence meets the bar above before editing this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO REMOVE A TLD
 * ─────────────────────────────────────────────────────────────────────────────
 * Remove an entry only when the TLD has demonstrably cleaned up:
 *   • Google no longer lists it as a top-abused extension, AND
 *   • Internal disavow data shows < 5 % spam rate for that extension over
 *     a rolling 6-month window.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const SPAM_TLDS: ReadonlySet<string> = new Set([
  // ── Free / high-abuse ccTLDs (historically used for free domain registration) ──
  "gq", // Equatorial Guinea — abused as free domain (Freenom era)
  "ml", // Mali — abused as free domain (Freenom era)
  "ga", // Gabon — abused as free domain (Freenom era)
  "cf", // Central African Republic — abused as free domain (Freenom era)
  "tk", // Tokelau — abused as free domain (Freenom era)

  // ── Generic new-gTLDs with persistently high spam rates ──
  "xyz", // Consistently top-3 in spam TLD reports (Spamhaus 2022-2024)
  "click", // Link-farm / redirect abuse
  "loan", // Financial phishing and link spam
  "top", // High spam ratio per Spamhaus 2023 report
  "club", // Frequent link-farm use
  "pw", // Palau — gTLD-positioned, heavy link-spam use
  "country", // Link-farm campaigns
  "stream", // Piracy and spam link networks
  "download", // Malware / spam distribution
  "work", // Low-cost domain spam
  "cricket", // Link-spam campaigns
  "science", // Link-spam campaigns
  "racing", // Link-spam campaigns
  "date", // Link-spam / dating-spam networks
  "review", // Fake-review and link-spam networks
  "trade", // Financial spam and link networks
  "win", // Gambling and link-spam campaigns
  "bid", // Auction spam and link networks
  "party", // Link-farm / entertainment spam
  "accountant", // Financial phishing and link spam
  "webcam", // Adult spam networks
  "faith", // Link-spam campaigns
  "men", // Adult spam / link-spam networks
  "icu", // Emerging high-abuse gTLD (Spamhaus 2022-2023)
  "buzz", // Link-farm and content-spam networks
  "rest", // Link-spam campaigns
  "online", // High-volume spam registration (Spamhaus 2023)
  "site", // High-volume spam registration (Spamhaus 2023)
]);
