/**
 * Authoritative list of anchor-text patterns disproportionately associated
 * with manipulative link-building campaigns.
 *
 * This file is the single source of truth for anchor-text spam detection used
 * by the toxicity scorer. Edit only this file — never backlink-toxicity.ts —
 * when the list needs updating.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD AN ANCHOR PHRASE
 * ─────────────────────────────────────────────────────────────────────────────
 * Before adding, require at least ONE of:
 *   • A Google spam report or Search Central post citing exact-match commercial
 *     anchors as a ranking-manipulation signal.
 *   • A credible study (Ahrefs, SEMrush, Moz) identifying the phrase as
 *     over-represented in penalised link profiles.
 *   • Pattern observed across ≥ 3 unrelated client disavow exports in the same
 *     quarter with anchor-spam share > 30 %.
 *
 * Steps:
 *   1. Add the lowercase phrase string to the `SPAM_ANCHORS` array below.
 *   2. Add a short inline comment referencing the evidence source and date.
 *   3. Run `pnpm --filter @workspace/dashboard test` and confirm all tests pass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO REMOVE AN ANCHOR PHRASE
 * ─────────────────────────────────────────────────────────────────────────────
 * Remove an entry only when:
 *   • The phrase is no longer cited as a manipulation signal, AND
 *   • Internal disavow data shows < 5 % spam rate for that anchor over a
 *     rolling 6-month window.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Matching rules (applied in backlink-toxicity.ts):
 *   - Comparison is case-insensitive and trims surrounding whitespace.
 *   - A match fires when the normalised anchor CONTAINS the phrase as a whole
 *     word/phrase boundary (substring-at-word-boundary), so "cheap viagra" will
 *     match "buy cheap viagra online" but not "cheapviagraonline".
 */
export const SPAM_ANCHORS: ReadonlyArray<string> = [
  // ── Pharmaceutical / health spam ──────────────────────────────────────────
  "cheap viagra",         // Classic pharma-hack anchor (Google Search Central 2022)
  "buy viagra",           // Pharma-hack link campaigns
  "viagra online",        // Pharma-hack link campaigns
  "cheap cialis",         // Pharma-hack anchor
  "buy cialis",           // Pharma-hack link campaigns
  "cialis online",        // Pharma-hack link campaigns
  "online pharmacy",      // Pharma spam networks
  "cheap pills",          // Generic pharma spam

  // ── Gambling / casino spam ────────────────────────────────────────────────
  "online casino",        // Gambling link networks (Ahrefs Spam Study 2023)
  "casino online",        // Gambling link networks
  "best online casino",   // Gambling link-farm anchor
  "play casino",          // Gambling link-farm anchor
  "slots online",         // Gambling link-farm anchor
  "poker online",         // Gambling link-farm anchor
  "online gambling",      // Gambling link networks
  "sports betting",       // Gambling link networks
  "bet online",           // Gambling link-farm anchor

  // ── Payday / financial spam ───────────────────────────────────────────────
  "payday loans",         // Financial spam (Spamhaus link-abuse report 2022)
  "payday loan",          // Financial spam
  "instant loans",        // Financial spam networks
  "bad credit loans",     // Financial phishing anchor
  "no credit check",      // Financial spam anchor
  "cheap loans",          // Financial spam anchor
  "personal loans online", // Financial spam networks

  // ── SEO / link-building spam ──────────────────────────────────────────────
  "cheap seo",            // Link-spam for SEO service sites
  "buy backlinks",        // Direct link-scheme anchor (Google Spam Policy)
  "buy links",            // Direct link-scheme anchor
  "seo services",         // Over-represented in link-scheme profiles
  "link building services", // Link-scheme anchor
  "guest post",           // Over-optimised paid-post anchor

  // ── Essay / academic fraud ─────────────────────────────────────────────────
  "buy essay",            // Essay-mill spam networks
  "cheap essay",          // Essay-mill spam networks
  "write my essay",       // Essay-mill spam anchor
  "essay writing service", // Essay-mill spam networks

  // ── Dating / adult spam ───────────────────────────────────────────────────
  "dating site",          // Adult/dating spam link networks
  "hookup site",          // Adult spam anchor
  "meet singles",         // Dating spam anchor
];
