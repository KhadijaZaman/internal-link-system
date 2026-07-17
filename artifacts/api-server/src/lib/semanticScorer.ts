import type { PageClassification, WpPost, LinkingSettings } from "@workspace/db";

export interface ScoreBreakdown {
  similarity: number;
  authority: number;
  anchorFit: number;
  freshness: number;
  total: number;
}

export function cosineSim(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function authorityScore(inboundCount: number, maxInbound: number): number {
  if (maxInbound <= 0) return 0;
  return Math.min(1, Math.log1p(inboundCount) / Math.log1p(maxInbound));
}

export function anchorFitScore(
  anchor: string,
  donorBody: string | null,
): number {
  if (!anchor || !donorBody) return 0;
  const lower = donorBody.toLowerCase();
  const a = anchor.toLowerCase().trim();
  if (lower.includes(a)) return 1;
  const tokens = a.split(/\W+/).filter((t) => t.length > 3);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return hits / tokens.length;
}

export function freshnessScore(modifiedAt: Date | null | undefined): number {
  if (!modifiedAt) return 0.2;
  const days = (Date.now() - modifiedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days < 30) return 1;
  if (days < 90) return 0.8;
  if (days < 180) return 0.6;
  if (days < 365) return 0.4;
  return 0.2;
}

export function combineScore(b: Omit<ScoreBreakdown, "total">): number {
  return b.similarity * 0.5 + b.authority * 0.2 + b.anchorFit * 0.2 + b.freshness * 0.1;
}

// Tier flow per SOP §7.2.1. Returns true if (donor.tier -> receiver.tier) is allowed.
export function tierAllowed(donorTier: number, receiverTier: number): boolean {
  const pair = `${donorTier}->${receiverTier}`;
  const allowed = new Set([
    "4->2",
    "4->3",
    "3->2",
    "3->3",
    "3->1",
    "2->1",
    "2->2",
    "2->3",
    "1->1",
    "1->2",
  ]);
  return allowed.has(pair);
}

export function tierPair(donorTier: number | null, receiverTier: number | null): string {
  return `T${donorTier ?? "?"}->T${receiverTier ?? "?"}`;
}

const BANNED_ANCHORS = new Set([
  "click here",
  "read more",
  "learn more",
  "here",
  "this",
  "this article",
  "this guide",
  "more info",
  "details",
  "see here",
]);

export function isBannedAnchor(anchor: string): boolean {
  const a = anchor.toLowerCase().trim();
  if (BANNED_ANCHORS.has(a)) return true;
  if (/^https?:/i.test(a)) return true;
  const words = a.split(/\s+/).filter(Boolean);
  if (words.length > 8) return true;
  if (words.length < 2 && a.length < 4) return true;
  return false;
}

export interface DensityCheckInput {
  wordCount: number;
  currentOutbound: number;
  tier: number | null;
  isHub?: boolean;
  settings: LinkingSettings;
}

export function densityAllowsMore(input: DensityCheckInput): boolean {
  const { wordCount, currentOutbound, tier, settings } = input;
  if (wordCount < 400) return currentOutbound < settings.shortPageMaxLinks;
  const per1000 = (currentOutbound / Math.max(wordCount, 1)) * 1000;
  let max = settings.densityMaxPer1000;
  if (input.isHub) max = settings.hubDensityMaxPer1000;
  else if (tier === 1) max = settings.moneyDensityMaxPer1000;
  return per1000 < max;
}

export function pickAnchorVariants(
  receiver: PageClassification | null,
  receiverPost: WpPost | null,
): { primary: string; variants: string[] } {
  const variants: string[] = [];
  if (receiver?.anchorVariants) {
    for (const v of receiver.anchorVariants) {
      if (v && !isBannedAnchor(v) && !variants.includes(v)) variants.push(v);
    }
  }
  if (receiverPost?.h1) {
    const h1 = receiverPost.h1.trim();
    if (!isBannedAnchor(h1) && !variants.includes(h1)) variants.push(h1);
  }
  if (receiverPost?.title) {
    const t = receiverPost.title.trim();
    if (!isBannedAnchor(t) && !variants.includes(t)) variants.push(t);
  }
  const primary = variants[0] ?? receiverPost?.title ?? receiverPost?.url ?? "";
  return { primary, variants: variants.slice(0, 3) };
}

export function findPlacementHint(
  donorBody: string | null,
  anchor: string,
): string | null {
  if (!donorBody) return null;
  const body = donorBody.replace(/\s+/g, " ").trim();
  const a = anchor.toLowerCase();
  const paragraphs = body.split(/(?<=[.!?])\s+(?=[A-Z])/);
  // Find paragraph containing the anchor (or its tokens).
  const tokens = a.split(/\W+/).filter((t) => t.length > 3);
  let best: { p: string; score: number } | null = null;
  for (const p of paragraphs) {
    const lp = p.toLowerCase();
    let score = 0;
    if (lp.includes(a)) score += 3;
    for (const t of tokens) if (lp.includes(t)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { p, score };
  }
  if (!best) return paragraphs.find((p) => p.length > 60) ?? null;
  return best.p.length > 400 ? best.p.slice(0, 400) + "…" : best.p;
}
