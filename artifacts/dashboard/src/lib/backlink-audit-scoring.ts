/**
 * Pure functions for building the toxicity-scored domain candidate list that
 * powers ReferringDomainsCard.
 *
 * The referring-domains fetch is ordered by backlink volume (high-traffic bias)
 * and may omit low-authority spam sources entirely.  The topBacklinks response
 * contains a low-rank batch (order_by domain_from_rank,asc) that captures
 * those low-authority domains.  This module merges both into a single candidate
 * list so the anchor-spam scorer has data for every relevant domain.
 */
import type { AuditReferringDomain, TopBacklink } from "@workspace/api-client-react";
import { scoreDomain, isDomainFlagged, type DomainRisk } from "./backlink-toxicity";

export interface ScoredDomain {
  domain: AuditReferringDomain;
  risk: DomainRisk;
}

/**
 * Build a map of lowercase-domain → anchor texts from topBacklinks.
 * Only entries with both a domainFrom and an anchor string are included.
 */
export function buildDomainAnchors(topBacklinks: TopBacklink[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const bl of topBacklinks) {
    if (!bl.domainFrom || !bl.anchor) continue;
    const key = bl.domainFrom.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.push(bl.anchor);
    } else {
      map.set(key, [bl.anchor]);
    }
  }
  return map;
}

/**
 * Build the full candidate list for toxicity scoring:
 *   1. All `referringDomains` entries (from the high-volume-sorted API fetch).
 *   2. Any low-authority domains present in `topBacklinks` (domainFromRank < 30
 *      or null/unranked) that are NOT already in `referringDomains`.
 *
 * These extra candidates receive anchor data from topBacklinks and are scored
 * normally — they appear in the flagged view and disavow set when they trigger
 * toxicity signals such as "Anchor spam".
 *
 * The `backlinks` count for extra candidates is set to 1 (at least one known
 * link exists); the actual per-domain backlink count is not available outside
 * the referringDomains response.
 */
export function buildScoredCandidates(
  referringDomains: AuditReferringDomain[],
  topBacklinks: TopBacklink[],
): ScoredDomain[] {
  const domainAnchors = buildDomainAnchors(topBacklinks);

  // Normalise the referring-domains set so domain key look-ups are case-insensitive.
  const refSet = new Set(referringDomains.map((d) => d.domain.toLowerCase()));

  // Collect low-rank backlink domains absent from the referring-domains list.
  const extraSeen = new Set<string>();
  const extras: AuditReferringDomain[] = [];
  for (const bl of topBacklinks) {
    const key = bl.domainFrom.toLowerCase();
    if (!bl.domainFrom || refSet.has(key) || extraSeen.has(key)) continue;
    // Only include domains with low or absent rank — these are the ones the
    // referring-domains fetch (sorted by backlink volume) is most likely to miss.
    const isLowAuth =
      bl.domainFromRank === null ||
      bl.domainFromRank === undefined ||
      bl.domainFromRank < 30;
    if (!isLowAuth) continue;
    extraSeen.add(key);
    extras.push({
      domain: bl.domainFrom,
      backlinks: 1,
      rank: bl.domainFromRank ?? null,
      firstSeen: bl.firstSeen ?? null,
      lastSeen: bl.lastSeen ?? null,
    });
  }

  return [...referringDomains, ...extras].map((d) => {
    const anchors = domainAnchors.get(d.domain.toLowerCase()) ?? [];
    return {
      domain: d,
      risk: scoreDomain(d.domain, d.rank, d.backlinks, anchors),
    };
  });
}

export { isDomainFlagged };
