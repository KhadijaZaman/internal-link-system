import { isNotNull } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  pageClassificationsTable,
  linkGraphTable,
  linkSuggestionsTable,
  linkExcludeListTable,
  linkStatsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { checkContextualConsistency } from "../integrations/claude";
import { cosineSim, densityAllowsMore, tierAllowed } from "../lib/semanticScorer";
import { isHomepage, sectionFor, HOMEPAGE_MAX_OUTBOUND_SUGGESTIONS } from "../lib/sections";
import {
  type Page,
  type Proposal,
  scorePair,
  loadSettings,
  compilePattern,
  isExcluded,
} from "./semanticLinking";

// Engine tag written to link_suggestions.engine_version so structural fixes are
// distinguishable in the existing suggestions inbox (Approve / Reject / Copy all
// work unchanged).
export const STRUCTURAL_ENGINE_VERSION = "structural-v1";

// On-demand, per-URL trigger — keep candidate volume (and therefore CRS / Claude
// spend) bounded.
const TOP_PER_TARGET = 8;
const CRS_ENABLED = process.env["SEMANTIC_USE_CRS_CHECK"] !== "0";

export type StructuralRole = "orphan" | "dead_end" | "both" | "none";

export interface StructuralResult {
  url: string;
  role: StructuralRole;
  generated: number;
  skipped: boolean;
  reason: string | null;
}

/**
 * Targeted internal-link suggestion for a single structurally-broken page.
 *
 * Unlike the weekly semantic reverse pass (which keys on RECENCY: older donors
 * → newly published targets), this is keyed on STRUCTURAL state:
 *   - an orphan (no inbound in-body links) is treated as the RECEIVER — we scan
 *     every eligible donor that could naturally link IN to it.
 *   - a dead-end (no outbound in-body links) is treated as the DONOR — we scan
 *     every eligible receiver it could link OUT to.
 * A page that is both gets both passes. Proposals reuse the exact same scorer +
 * CRS factual-consistency gate as the semantic engine and land in the shared
 * link_suggestions inbox tagged "structural-v1".
 */
export async function runStructuralLinking(targetUrl: string): Promise<StructuralResult> {
  const settings = await loadSettings();
  const [posts, classifications, excludes, stats, edges, existingSuggestions] = await Promise.all([
    db.select().from(wpPostsTable).where(isNotNull(wpPostsTable.embedding)),
    db.select().from(pageClassificationsTable),
    db.select().from(linkExcludeListTable),
    db.select().from(linkStatsTable),
    db.select().from(linkGraphTable),
    db
      .select({
        donorUrl: linkSuggestionsTable.donorUrl,
        receiverUrl: linkSuggestionsTable.receiverUrl,
      })
      .from(linkSuggestionsTable),
  ]);

  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));
  const classByUrl = new Map(classifications.map((c) => [c.url, c]));
  const statsByUrl = new Map(stats.map((s) => [s.url, s]));

  const stat = statsByUrl.get(targetUrl);
  if (!stat) {
    return {
      url: targetUrl,
      role: "none",
      generated: 0,
      skipped: true,
      reason: "URL not found in link stats — run the link-map crawl first.",
    };
  }
  const isOrphan = stat.isOrphan;
  const isDeadEnd = stat.isDeadEnd;
  const role: StructuralRole =
    isOrphan && isDeadEnd ? "both" : isOrphan ? "orphan" : isDeadEnd ? "dead_end" : "none";
  if (role === "none") {
    return {
      url: targetUrl,
      role,
      generated: 0,
      skipped: true,
      reason: "URL is neither an orphan nor a dead-end — nothing to fix.",
    };
  }

  if (isExcluded(targetUrl, excludeRegexes)) {
    return {
      url: targetUrl,
      role,
      generated: 0,
      skipped: true,
      reason: "URL is on the link exclude list.",
    };
  }

  const pages: Page[] = posts
    .filter((p) => !isExcluded(p.url, excludeRegexes))
    .map((p) => ({
      post: p,
      cls: classByUrl.get(p.url) ?? null,
      inboundCount: statsByUrl.get(p.url)?.inboundCount ?? 0,
    }));

  const targetPage = pages.find((p) => p.post.url === targetUrl);
  if (!targetPage) {
    return {
      url: targetUrl,
      role,
      generated: 0,
      skipped: true,
      reason: "Page has no embedding yet — run a crawl + embed before generating links.",
    };
  }

  const maxInbound = pages.reduce((m, p) => Math.max(m, p.inboundCount), 1);
  const outboundCounts = new Map<string, number>();
  for (const e of edges) {
    outboundCounts.set(e.sourceUrl, (outboundCounts.get(e.sourceUrl) ?? 0) + 1);
  }

  // Never propose an in-body link that already exists, and never re-emit a pair
  // that already exists in any suggestion status (honours "never duplicated").
  const existingEdges = new Set<string>();
  for (const e of edges) {
    if (e.placement !== "content") continue;
    existingEdges.add(`${e.sourceUrl}||${e.targetUrl}`);
  }
  const suppressedPairs = new Set<string>();
  for (const s of existingSuggestions) {
    suppressedPairs.add(`${s.donorUrl}||${s.receiverUrl}`);
  }

  const proposals: Proposal[] = [];

  // ---------- Orphan pass: target is RECEIVER, find donors linking IN ----------
  if (isOrphan && targetPage.cls?.topicalBordersMatch !== false) {
    const receiver = targetPage;
    const receiverTier = receiver.cls?.tier ?? 4;
    const scored: Array<{ donor: Page; sim: number }> = [];
    for (const donor of pages) {
      if (donor.post.url === receiver.post.url) continue;
      if (donor.cls?.topicalBordersMatch === false) continue;
      const donorTier = donor.cls?.tier ?? 4;
      if (!tierAllowed(donorTier, receiverTier)) continue;
      // Homepage donor restriction: even when filling an orphan, never propose
      // homepage → non-core (blog) links.
      if (isHomepage(donor.post.url) && sectionFor(receiver.post.url) !== "core") continue;
      if (existingEdges.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      if (suppressedPairs.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      if (
        !densityAllowsMore({
          wordCount: donor.post.wordCount ?? 0,
          currentOutbound: outboundCounts.get(donor.post.url) ?? 0,
          tier: donorTier,
          settings,
        })
      )
        continue;
      const sim = cosineSim(donor.post.embedding, receiver.post.embedding);
      if (sim < settings.similarityThreshold) continue;
      scored.push({ donor, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    for (const { donor, sim } of scored.slice(0, TOP_PER_TARGET)) {
      const p = scorePair({ donor, receiver, sim, maxInbound, settings, outboundCounts, isReverse: false });
      if (p) proposals.push(p);
    }
  }

  // ---------- Dead-end pass: target is DONOR, find receivers to link OUT to ----------
  if (
    isDeadEnd &&
    targetPage.cls?.topicalBordersMatch !== false &&
    densityAllowsMore({
      wordCount: targetPage.post.wordCount ?? 0,
      currentOutbound: outboundCounts.get(targetPage.post.url) ?? 0,
      tier: targetPage.cls?.tier ?? 4,
      settings,
    })
  ) {
    const donor = targetPage;
    const donorTier = donor.cls?.tier ?? 4;
    const donorIsHome = isHomepage(donor.post.url);
    const scored: Array<{ receiver: Page; sim: number }> = [];
    for (const receiver of pages) {
      if (receiver.post.url === donor.post.url) continue;
      if (receiver.cls?.topicalBordersMatch === false) continue;
      const receiverTier = receiver.cls?.tier ?? 4;
      if (!tierAllowed(donorTier, receiverTier)) continue;
      // Homepage donor restriction: only let the homepage donate to high-value
      // "core" pages, never random blog/"outer" posts.
      if (donorIsHome && sectionFor(receiver.post.url) !== "core") continue;
      if (existingEdges.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      if (suppressedPairs.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      const sim = cosineSim(donor.post.embedding, receiver.post.embedding);
      if (sim < settings.similarityThreshold) continue;
      scored.push({ receiver, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    for (const { receiver, sim } of scored.slice(
      0,
      donorIsHome ? HOMEPAGE_MAX_OUTBOUND_SUGGESTIONS : TOP_PER_TARGET,
    )) {
      const p = scorePair({ donor, receiver, sim, maxInbound, settings, outboundCounts, isReverse: false });
      if (p) proposals.push(p);
    }
  }

  // De-duplicate (a both-page could surface the same pair twice) and rank.
  const byPair = new Map<string, Proposal>();
  for (const p of proposals) {
    const k = `${p.donor.post.url}||${p.receiver.post.url}`;
    const prev = byPair.get(k);
    if (!prev || p.total > prev.total) byPair.set(k, p);
  }
  const top = [...byPair.values()].sort((a, b) => b.total - a.total).slice(0, TOP_PER_TARGET * 2);

  // CRS factual-consistency gate (Claude Haiku). Fail-closed: drop anything not
  // explicitly kept, mirroring the semantic engine.
  const droppedByCrs = new Set<string>();
  if (CRS_ENABLED) {
    for (const p of top) {
      const verdict = await checkContextualConsistency({
        donorExcerpt: p.donor.post.bodyText ?? "",
        targetUrl: p.receiver.post.url,
        targetH1: p.receiver.post.h1 ?? p.receiver.post.title ?? "",
        anchorText: p.anchorPrimary,
      });
      if (!verdict.decided || !verdict.keep) {
        droppedByCrs.add(`${p.donor.post.url}||${p.receiver.post.url}`);
      }
    }
  }

  let inserted = 0;
  for (const p of top) {
    if (droppedByCrs.has(`${p.donor.post.url}||${p.receiver.post.url}`)) continue;
    const direction =
      p.donor.post.url === targetUrl
        ? "dead-end donor → new outbound link"
        : "orphan receiver ← new inbound link";
    const rationale =
      `structural • ${p.tierPairLabel} • sim ${p.similarity.toFixed(2)} · auth ${p.authority.toFixed(2)} · ` +
      `anchor-fit ${p.anchorFit.toFixed(2)} · fresh ${p.freshness.toFixed(2)} · q ${p.quality.toFixed(2)} · ${direction}`;
    try {
      const res = await db
        .insert(linkSuggestionsTable)
        .values({
          donorUrl: p.donor.post.url,
          receiverUrl: p.receiver.post.url,
          anchorText: p.anchorPrimary,
          korayRationale: rationale,
          sectionLinkType: p.sectionLinkType,
          insertionSentence: p.placementHint,
          placementHint: p.placementHint,
          priorityScore: p.total,
          similarityScore: p.similarity,
          authorityScore: p.authority,
          anchorFitScore: p.anchorFit,
          freshnessScore: p.freshness,
          anchorVariants: p.anchorVariants,
          tierPair: p.tierPairLabel,
          engineVersion: STRUCTURAL_ENGINE_VERSION,
          status: "pending_review",
        })
        .onConflictDoNothing()
        .returning({ id: linkSuggestionsTable.id });
      if (res.length > 0) inserted++;
    } catch (e) {
      logger.warn({ err: e }, "Structural linking: insert failed");
    }
  }

  logger.info(
    { url: targetUrl, role, candidates: top.length, droppedByCrs: droppedByCrs.size, generated: inserted },
    "Structural linking: done",
  );
  return { url: targetUrl, role, generated: inserted, skipped: false, reason: null };
}
