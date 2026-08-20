export type OpportunityFunnelStage = "tofu" | "mofu" | "bofu";

export interface FunnelBalanceCandidate {
  id: number;
  intent: string;
  predicate: string;
  pageType: string;
  funnelStage: string;
}

const STAGES: OpportunityFunnelStage[] = ["tofu", "mofu", "bofu"];

function compatibleStages(candidate: FunnelBalanceCandidate): OpportunityFunnelStage[] {
  const text =
    `${candidate.intent} ${candidate.predicate} ${candidate.pageType}`.toLowerCase();
  const allowed = new Set<OpportunityFunnelStage>();

  if (
    candidate.intent === "informational" ||
    /\b(know|learn|what|why|guide|definition|glossary|how[-_ ]?to)\b/.test(text)
  ) {
    allowed.add("tofu");
    allowed.add("mofu");
  }
  if (
    candidate.intent === "commercial" ||
    /\b(compare|comparison|versus|vs|best|alternative|evaluate|case[-_ ]?study)\b/.test(text)
  ) {
    allowed.add("mofu");
    allowed.add("bofu");
  }
  if (
    candidate.intent === "transactional" ||
    candidate.intent === "navigational" ||
    /\b(buy|pricing|price|cost|hire|demo|trial|service|software|tool|vendor|agency|consultant)\b/.test(
      text,
    )
  ) {
    allowed.add("bofu");
    allowed.add("mofu");
  }

  if (STAGES.includes(candidate.funnelStage as OpportunityFunnelStage)) {
    allowed.add(candidate.funnelStage as OpportunityFunnelStage);
  }
  if (allowed.size === 0) allowed.add("tofu");
  return STAGES.filter((stage) => allowed.has(stage));
}

/**
 * Balance new opportunity topics across TOFU/MOFU/BOFU while respecting
 * intent-compatible assignments. Covered nodes never enter this function.
 */
export function balanceOpportunityFunnelStages(
  candidates: FunnelBalanceCandidate[],
): Map<number, OpportunityFunnelStage> {
  const assignments = new Map<number, OpportunityFunnelStage>();
  if (candidates.length === 0) return assignments;

  const base = Math.floor(candidates.length / STAGES.length);
  const remainder = candidates.length % STAGES.length;
  const target = new Map<OpportunityFunnelStage, number>(
    STAGES.map((stage, index) => [stage, base + (index < remainder ? 1 : 0)]),
  );
  const assigned = new Map<OpportunityFunnelStage, number>(
    STAGES.map((stage) => [stage, 0]),
  );

  const ordered = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      allowed: compatibleStages(candidate),
    }))
    .sort(
      (a, b) =>
        a.allowed.length - b.allowed.length ||
        a.index - b.index ||
        a.candidate.id - b.candidate.id,
    );

  for (const { candidate, allowed } of ordered) {
    const original = STAGES.includes(candidate.funnelStage as OpportunityFunnelStage)
      ? (candidate.funnelStage as OpportunityFunnelStage)
      : null;
    const chosen = [...allowed].sort((a, b) => {
      const aTarget = target.get(a) ?? 0;
      const bTarget = target.get(b) ?? 0;
      const aFill = (assigned.get(a) ?? 0) / Math.max(aTarget, 0.5);
      const bFill = (assigned.get(b) ?? 0) / Math.max(bTarget, 0.5);
      if (aFill !== bFill) return aFill - bFill;
      if (a === original && b !== original) return -1;
      if (b === original && a !== original) return 1;
      return STAGES.indexOf(a) - STAGES.indexOf(b);
    })[0]!;
    assignments.set(candidate.id, chosen);
    assigned.set(chosen, (assigned.get(chosen) ?? 0) + 1);
  }

  return assignments;
}