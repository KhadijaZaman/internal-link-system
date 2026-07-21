/**
 * Single URL-hygiene module. EVERY ingestion path (GSC sync, GA4 fetch,
 * crawler, WordPress sync) and every live read that joins on URL/path must
 * pass URLs through here before storing or comparing them.
 *
 * Canonical form: lowercase pathname only — origin, query string and
 * #fragment stripped, no trailing slash ("/" stays "/"). GSC records
 * /page/#anchor and ?param variants as separate pages, so metrics for the
 * same canonical path must be re-aggregated (sum clicks/impressions,
 * impression-weighted average position) after collapsing.
 */

/** Normalize a user-entered domain to the canonical bare host. */
export function normalizeHost(domain: string): string {
  return domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .toLowerCase();
}

/** Origin (https://host) for a site's canonical bare host. */
export function siteOrigin(siteHost: string): string {
  return `https://${normalizeHost(siteHost)}`;
}

/**
 * Collapse an absolute URL or bare path to its canonical path key for the
 * given site host. Returns null for URLs on a foreign host (they have no
 * canonical path on this site) and for unparseable values like GA4's
 * "(not set)".
 */
export function canonicalPath(raw: string, siteHost: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== normalizeHost(siteHost)) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null; // "(not set)", garbage, etc.
  const noQuery = path.split("?")[0] ?? path;
  const noHash = noQuery.split("#")[0] ?? noQuery;
  let p = noHash.toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** Canonical absolute URL for a canonical path on the given site host. */
export function canonicalUrl(path: string, siteHost: string): string {
  return `${siteOrigin(siteHost)}${path === "/" ? "/" : path}`;
}

// ---------- Blocklist matching ----------

/**
 * Compile a blocklist pattern to a RegExp tested against the canonical path.
 * `*` is the only wildcard (matches any run of characters). Path patterns
 * containing `*` or ending with `/` are prefix-anchored: "/gameplan*" matches
 * /gameplan and /gameplan-x, "/auth/*" matches /auth/anything, "/wp-content/"
 * matches any path starting with /wp-content/. Bare path patterns with no
 * wildcard (e.g. crawler-404 entries like "/pricing-old") are EXACT matches —
 * otherwise a single 404 would silently blocklist every path sharing that
 * prefix. Non-path patterns like "(not set)" are exact literals.
 */
export function compileBlockPattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  if (trimmed.startsWith("/")) {
    const isPrefix = trimmed.includes("*") || trimmed.endsWith("/");
    return new RegExp(`^${escaped}${isPrefix ? "" : "$"}`);
  }
  return new RegExp(`^${escaped}$`);
}

export function isBlockedPath(path: string, regexes: RegExp[]): boolean {
  return regexes.some((re) => re.test(path));
}

/** Load and compile one site's url_blocklist rows into matchers. */
export async function loadBlockRegexes(siteId: number): Promise<RegExp[]> {
  const { db, urlBlocklistTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ pattern: urlBlocklistTable.pattern })
    .from(urlBlocklistTable)
    .where(eq(urlBlocklistTable.siteId, siteId));
  return rows.map((r) => compileBlockPattern(r.pattern));
}

/** Seed patterns for the url_blocklist table (spec Phase 1.2). */
export const BLOCKLIST_SEEDS: Array<{ pattern: string; note: string }> = [
  { pattern: "/wp-content/", note: "asset paths, not content (seed)" },
  { pattern: "/blog/author/*/page/*", note: "author pagination (seed)" },
  { pattern: "/auth/*", note: "app screen (seed)" },
  { pattern: "/account/*", note: "app screen (seed)" },
  { pattern: "/overview/*", note: "app screen (seed)" },
  { pattern: "/queries/*", note: "app screen (seed)" },
  { pattern: "/gameplan*", note: "app screen (seed)" },
  { pattern: "/historical-overview/*", note: "app screen (seed)" },
  { pattern: "/project/*", note: "app screen (seed)" },
  { pattern: "/content-optimization/*", note: "app screen (seed)" },
  { pattern: "/content-suggestion*", note: "app screen (seed)" },
  { pattern: "/ai-strategy/*", note: "app screen (seed)" },
  { pattern: "/agent/*", note: "app screen (seed)" },
  { pattern: "/monitoring/*", note: "app screen (seed)" },
  { pattern: "/activities/*", note: "app screen (seed)" },
  { pattern: "/accept-invitation/*", note: "app screen (seed)" },
  { pattern: "/error/*", note: "error pages (seed)" },
  { pattern: "(not set)", note: "GA4 placeholder row (seed)" },
];

// ---------- Metric re-aggregation ----------

export interface MetricRow {
  clicks: number;
  impressions: number;
  position: number;
}

export interface AggregatedMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Merge metric rows that collapsed onto the same canonical key: clicks and
 * impressions are summed; position is the impression-weighted average
 * (weight floor of 1 so zero-impression rows still contribute).
 */
export function mergeMetricRows(rows: MetricRow[]): AggregatedMetrics {
  let clicks = 0;
  let impressions = 0;
  let posSum = 0;
  let posWeight = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    const w = Math.max(r.impressions, 1);
    posSum += r.position * w;
    posWeight += w;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: posWeight > 0 ? posSum / posWeight : 0,
  };
}

/**
 * Group rows by a canonical key and merge each group's metrics. Rows whose
 * key resolves to null (foreign host / garbage) or a blocked path are
 * dropped. Returns a map keyed by canonical key.
 */
export function aggregateByCanonical<T extends MetricRow>(
  rows: T[],
  keyOf: (row: T) => string | null,
  blockRegexes: RegExp[],
): Map<string, { rows: T[]; merged: AggregatedMetrics }> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    if (isBlockedPath(key, blockRegexes)) continue;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, { rows: T[]; merged: AggregatedMetrics }>();
  for (const [key, g] of groups) {
    out.set(key, { rows: g, merged: mergeMetricRows(g) });
  }
  return out;
}
