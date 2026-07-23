import { isNotNull } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  pageClassificationsTable,
  linkGraphTable,
  linkSuggestionsTable,
  linkExcludeListTable,
  linkingSettingsTable,
  linkStatsTable,
  type WpPost,
  type PageClassification,
  type LinkingSettings,
} from "@workspace/db";
import { chainActionQueueRecompute } from "../services/actionQueue";
import { getLegacySite } from "../lib/site";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";
import { checkContextualConsistency } from "../integrations/claude";
import {
  anchorFitScore,
  authorityScore,
  combineScore,
  cosineSim,
  densityAllowsMore,
  findPlacementHint,
  freshnessScore,
  isBannedAnchor,
  pickAnchorVariants,
  tierAllowed,
  tierPair,
} from "../lib/semanticScorer";
import { isHomepage, sectionFor, HOMEPAGE_MAX_OUTBOUND_SUGGESTIONS } from "../lib/sections";

export const SEMANTIC_ENGINE_VERSION = "semantic-v1";
const TOP_PER_DONOR = 8;
const MAX_PROPOSALS = 200;
// Reverse-pass: posts (publish OR modified) within this window are "new targets".
const REVERSE_WINDOW_DAYS = 21;
// In the reverse pass, a donor only qualifies if it was published / last
// modified BEFORE this cutoff. This is what makes it a true reverse pass:
// older donors pointing INTO newly published content.
const REVERSE_DONOR_MIN_AGE_DAYS = 60;
// CRS (Contextual Relevance Soft-check) via Claude Haiku runs on top-N
// proposals to enforce SOP §7.2 factual-consistency. Enabled by default to
// satisfy SOP enforcement; set SEMANTIC_USE_CRS_CHECK=0 to disable (e.g. to
// avoid token spend in dry-runs).
const CRS_ENABLED = process.env["SEMANTIC_USE_CRS_CHECK"] !== "0";
// Anchor-fit hard gate: a candidate whose primary anchor doesn't appear
// (even partially) in the donor body is rejected outright, not just
// score-penalised. SOP §7.2 requires the anchor be a natural read in-place.
const ANCHOR_FIT_MIN = Number(process.env["SEMANTIC_ANCHOR_FIT_MIN"] ?? "0.25");

export function compilePattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

export function isExcluded(url: string, regexes: RegExp[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return regexes.some((re) => re.test(path) || re.test(url));
}

export async function loadSettings(): Promise<LinkingSettings> {
  const rows = await db.select().from(linkingSettingsTable).limit(1);
  if (rows.length > 0) return rows[0]!;
  const [row] = await db
    .insert(linkingSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const again = await db.select().from(linkingSettingsTable).limit(1);
  return again[0]!;
}

export interface Page {
  post: WpPost;
  cls: PageClassification | null;
  inboundCount: number;
}

/**
 * Quality-node downweight. Pages that look low-quality should not flood the
 * suggestion inbox as donors or be over-promoted as receivers. We don't have
 * a stored qualityScore, so we synthesize one from observable signals:
 *  - low word count
 *  - zero inbound links AND tier 4 (unclassified / outer)
 *  - explicit topicalBordersMatch=false flag from classifier
 * Returns a multiplier in [0.4, 1.0] applied to the combined score.
 */
function qualityMultiplier(p: Page): number {
  let q = 1;
  const wc = p.post.wordCount ?? 0;
  if (wc < 300) q *= 0.7;
  else if (wc < 600) q *= 0.9;
  const tier = p.cls?.tier ?? 4;
  if (tier === 4 && p.inboundCount === 0) q *= 0.7;
  if (p.cls?.topicalBordersMatch === false) q *= 0.6;
  return Math.max(0.4, q);
}

/**
 * Density-min boost. SOP §7.2 defines a corridor (default 2–4 links per 1000
 * words). Donors currently below the lower bound get a small score boost on
 * their outbound proposals — the engine should preferentially fill those
 * pages first.
 */
function densityMinBoost(donor: Page, settings: LinkingSettings, outbound: number): number {
  const wc = donor.post.wordCount ?? 0;
  if (wc < 400) return 1;
  const per1000 = (outbound / Math.max(wc, 1)) * 1000;
  return per1000 < settings.densityMinPer1000 ? 1.08 : 1;
}

export interface Proposal {
  donor: Page;
  receiver: Page;
  similarity: number;
  authority: number;
  anchorFit: number;
  freshness: number;
  quality: number;
  total: number;
  anchorPrimary: string;
  anchorVariants: string[];
  placementHint: string | null;
  sectionLinkType: string;
  tierPairLabel: string;
  isReverse: boolean;
}

export function scorePair(opts: {
  donor: Page;
  receiver: Page;
  sim: number;
  maxInbound: number;
  settings: LinkingSettings;
  outboundCounts: Map<string, number>;
  isReverse: boolean;
}): Proposal | null {
  const { donor, receiver, sim, maxInbound, settings, outboundCounts, isReverse } = opts;
  const { primary, variants } = pickAnchorVariants(receiver.cls, receiver.post);
  if (!primary || isBannedAnchor(primary)) return null;
  const fit = anchorFitScore(primary, donor.post.bodyText);
  // Hard gate: anchor must have plausible textual presence in the donor body.
  if (fit < ANCHOR_FIT_MIN) return null;
  const auth = authorityScore(receiver.inboundCount, maxInbound);
  const fresh = freshnessScore(receiver.post.modifiedDate ?? receiver.post.publishDate);
  const base = combineScore({ similarity: sim, authority: auth, anchorFit: fit, freshness: fresh });
  const donorQ = qualityMultiplier(donor);
  const recvQ = qualityMultiplier(receiver);
  const minBoost = densityMinBoost(donor, settings, outboundCounts.get(donor.post.url) ?? 0);
  const reverseBoost = isReverse ? 1.1 : 1;
  const total = Math.min(1, base * donorQ * recvQ * minBoost * reverseBoost);
  const sectionLinkType = `${donor.cls?.tier ? `t${donor.cls.tier}` : "outer"}_to_${
    receiver.cls?.tier ? `t${receiver.cls.tier}` : "outer"
  }`;
  const placement = findPlacementHint(donor.post.bodyText, primary);
  return {
    donor,
    receiver,
    similarity: sim,
    authority: auth,
    anchorFit: fit,
    freshness: fresh,
    quality: Math.min(donorQ, recvQ),
    total,
    anchorPrimary: primary,
    anchorVariants: variants,
    placementHint: placement,
    sectionLinkType,
    tierPairLabel: tierPair(donor.cls?.tier ?? null, receiver.cls?.tier ?? null),
    isReverse,
  };
}

export async function runSemanticLinking(): Promise<void> {
  logger.info({ crsEnabled: CRS_ENABLED }, "Semantic linking: starting");
  const settings = await withDbRetry(() => loadSettings(), {
    label: "semantic_linking:settings",
  });
  const [posts, classifications, excludes, stats, edges, existingSuggestions] = await withDbRetry(
    () =>
      Promise.all([
        db.select().from(wpPostsTable).where(isNotNull(wpPostsTable.embedding)),
        db.select().from(pageClassificationsTable),
        db.select().from(linkExcludeListTable),
        db.select().from(linkStatsTable),
        db.select().from(linkGraphTable),
        db
          .select({
            donorUrl: linkSuggestionsTable.donorUrl,
            receiverUrl: linkSuggestionsTable.receiverUrl,
            status: linkSuggestionsTable.status,
          })
          .from(linkSuggestionsTable),
      ]),
    { label: "semantic_linking:reads" },
  );
  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));
  const classByUrl = new Map(classifications.map((c) => [c.url, c]));
  const statsByUrl = new Map(stats.map((s) => [s.url, s]));

  // Existing live link graph edges — never propose a link that already exists.
  // We only suppress on *content* (body) edges: if a page is only linked from
  // a sitewide nav/header/footer, that doesn't satisfy the editorial need for
  // an in-context link, so the engine should still propose one.
  const existingEdges = new Set<string>();
  for (const e of edges) {
    if (e.placement !== "content") continue;
    existingEdges.add(`${e.sourceUrl}||${e.targetUrl}`);
  }

  // Cross-engine, status-agnostic dedupe. If ANY suggestion (legacy or
  // semantic, in any status — pending, approved, inserted, OR rejected)
  // already exists for this donor→receiver pair, we never re-emit it. This
  // honours the "never duplicated" rule: a previously rejected pair must not
  // come back next week wearing a different anchor variant.
  const suppressedPairs = new Set<string>();
  for (const s of existingSuggestions) {
    suppressedPairs.add(`${s.donorUrl}||${s.receiverUrl}`);
  }

  const pages: Page[] = posts
    .filter((p) => !isExcluded(p.url, excludeRegexes))
    .map((p) => ({
      post: p,
      cls: classByUrl.get(p.url) ?? null,
      inboundCount: statsByUrl.get(p.url)?.inboundCount ?? 0,
    }));
  const maxInbound = pages.reduce((m, p) => Math.max(m, p.inboundCount), 1);

  // Outbound counts per donor (current state from link_graph).
  const outboundCounts = new Map<string, number>();
  for (const e of edges) {
    outboundCounts.set(e.sourceUrl, (outboundCounts.get(e.sourceUrl) ?? 0) + 1);
  }

  // Reverse-pass target set: pages published OR modified inside the window.
  const reverseCutoff = Date.now() - REVERSE_WINDOW_DAYS * 86_400_000;
  const reverseTargetUrls = new Set(
    pages
      .filter(
        (p) =>
          (p.post.publishDate && p.post.publishDate.getTime() > reverseCutoff) ||
          (p.post.modifiedDate && p.post.modifiedDate.getTime() > reverseCutoff),
      )
      .map((p) => p.post.url),
  );
  const reverseDonorAgeCutoff = Date.now() - REVERSE_DONOR_MIN_AGE_DAYS * 86_400_000;

  logger.info(
    { pages: pages.length, reverseTargets: reverseTargetUrls.size },
    "Semantic linking: candidate pools",
  );

  const proposals: Proposal[] = [];

  // ---------------- Forward pass ----------------
  // Every donor (regardless of age) scored against every receiver.
  for (const donor of pages) {
    const donorTier = donor.cls?.tier ?? 4;
    const donorIsHome = isHomepage(donor.post.url);
    const canEmitMore = densityAllowsMore({
      wordCount: donor.post.wordCount ?? 0,
      currentOutbound: outboundCounts.get(donor.post.url) ?? 0,
      tier: donorTier,
      settings,
    });
    if (!canEmitMore) continue;

    const scored: Array<{ receiver: Page; sim: number }> = [];
    for (const receiver of pages) {
      if (receiver.post.url === donor.post.url) continue;
      if (existingEdges.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      if (suppressedPairs.has(`${donor.post.url}||${receiver.post.url}`)) continue;
      if (receiver.cls && receiver.cls.topicalBordersMatch === false) continue;
      if (donor.cls && donor.cls.topicalBordersMatch === false) continue;
      const receiverTier = receiver.cls?.tier ?? 4;
      if (!tierAllowed(donorTier, receiverTier)) continue;
      // Homepage donor restriction: the homepage is a curated entry point and
      // must not accumulate many outbound links to random blog posts. Only let
      // it donate to high-value "core" pages (pricing/product/pillars); blog and
      // other "outer" pages are never proposed as homepage link targets.
      if (donorIsHome && sectionFor(receiver.post.url) !== "core") continue;
      const sim = cosineSim(donor.post.embedding, receiver.post.embedding);
      if (sim < settings.similarityThreshold) continue;
      scored.push({ receiver, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const perDonorCap = donorIsHome ? HOMEPAGE_MAX_OUTBOUND_SUGGESTIONS : TOP_PER_DONOR;
    for (const { receiver, sim } of scored.slice(0, perDonorCap)) {
      const p = scorePair({
        donor,
        receiver,
        sim,
        maxInbound,
        settings,
        outboundCounts,
        isReverse: false,
      });
      if (p) proposals.push(p);
    }
  }

  // ---------------- Reverse pass ----------------
  // For each newly published / modified TARGET, walk all OLDER donors that
  // could naturally link in. This is the dedicated reverse pass specified by
  // SOP §7.2: older donors → new targets, distinct from the forward sweep.
  let reversePairsConsidered = 0;
  for (const targetUrl of reverseTargetUrls) {
    const receiver = pages.find((p) => p.post.url === targetUrl);
    if (!receiver) continue;
    if (receiver.cls?.topicalBordersMatch === false) continue;
    const receiverTier = receiver.cls?.tier ?? 4;

    for (const donor of pages) {
      if (donor.post.url === receiver.post.url) continue;
      // Older-donor constraint — this is what makes it a reverse pass.
      const donorAgeRef = donor.post.modifiedDate ?? donor.post.publishDate;
      if (!donorAgeRef || donorAgeRef.getTime() > reverseDonorAgeCutoff) continue;
      if (donor.cls?.topicalBordersMatch === false) continue;
      const donorTier = donor.cls?.tier ?? 4;
      if (!tierAllowed(donorTier, receiverTier)) continue;
      // Homepage donor restriction (see forward pass): never propose homepage →
      // non-core (blog) links, even for freshly published targets.
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
      reversePairsConsidered++;
      const p = scorePair({
        donor,
        receiver,
        sim,
        maxInbound,
        settings,
        outboundCounts,
        isReverse: true,
      });
      if (p) proposals.push(p);
    }
  }
  logger.info(
    { reversePairs: reversePairsConsidered, totalProposals: proposals.length },
    "Semantic linking: reverse pass complete",
  );

  // De-duplicate within this run (same donor→receiver may be produced by both
  // forward and reverse passes — keep the higher-scoring one).
  const byPair = new Map<string, Proposal>();
  for (const p of proposals) {
    const k = `${p.donor.post.url}||${p.receiver.post.url}`;
    const prev = byPair.get(k);
    if (!prev || p.total > prev.total) byPair.set(k, p);
  }
  const unique = [...byPair.values()].sort((a, b) => b.total - a.total);
  const top = unique.slice(0, MAX_PROPOSALS);
  logger.info({ unique: unique.length, top: top.length }, "Semantic linking: ranked");

  // ---------------- CRS factual-consistency gate ----------------
  // Claude Haiku verifies EVERY proposal that would be inserted. Fail-closed:
  // any proposal whose check errors or returns no decision is dropped, never
  // silently kept. This makes factual consistency a true gate (SOP §7.2).
  const droppedByCrs = new Set<string>();
  if (CRS_ENABLED) {
    let dropped = 0;
    for (const p of top) {
      const verdict = await checkContextualConsistency({
        donorExcerpt: p.donor.post.bodyText ?? "",
        targetUrl: p.receiver.post.url,
        targetH1: p.receiver.post.h1 ?? p.receiver.post.title ?? "",
        anchorText: p.anchorPrimary,
      });
      // Strict gate: only accept an explicitly decided, parsed keep=true.
      // Parse errors, API errors, missing fields → drop.
      if (!verdict.decided || !verdict.keep) {
        droppedByCrs.add(`${p.donor.post.url}||${p.receiver.post.url}`);
        dropped++;
      }
    }
    logger.info({ checked: top.length, dropped }, "Semantic linking: CRS gate done");
  }

  // ---------------- Write proposals ----------------
  let inserted = 0;
  for (const p of top) {
    if (droppedByCrs.has(`${p.donor.post.url}||${p.receiver.post.url}`)) continue;
    const rationale =
      `${p.tierPairLabel} • sim ${p.similarity.toFixed(2)} · auth ${p.authority.toFixed(2)} · ` +
      `anchor-fit ${p.anchorFit.toFixed(2)} · fresh ${p.freshness.toFixed(2)} · q ${p.quality.toFixed(2)}` +
      (p.isReverse ? " · reverse-pass (older donor → new target)" : "");
    try {
      // Idempotent upsert (onConflictDoNothing) → safe to retry on a transient
      // connection/auth drop instead of silently losing the suggestion.
      const res = await withDbRetry(
        () =>
          db
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
              engineVersion: SEMANTIC_ENGINE_VERSION,
              status: "pending_review",
            })
            .onConflictDoNothing()
            .returning({ id: linkSuggestionsTable.id }),
        { label: "semantic_linking:insert" },
      );
      if (res.length > 0) inserted++;
    } catch (e) {
      logger.warn({ err: e }, "Semantic linking: insert failed");
    }
  }
  logger.info({ inserted, suppressed: suppressedPairs.size }, "Semantic linking: done");

  // New pending suggestions feed the action queue — refresh it.
  // Legacy-site-only until per-site job scheduling lands.
  const site = await getLegacySite();
  await chainActionQueueRecompute("semantic_linking", site.id);
}
