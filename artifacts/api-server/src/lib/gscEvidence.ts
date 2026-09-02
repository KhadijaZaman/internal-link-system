export type EvidenceSource =
  | "Google Search Console"
  | "Google Analytics 4"
  | "Bing Webmaster"
  | "Chrome UX Report"
  | "Site crawl";

export type EvidenceCapability =
  | "search-performance"
  | "analytics"
  | "bing-performance"
  | "sitemap-indexing"
  | "url-index-status"
  | "bing-indexing"
  | "copilot-citations"
  | "core-web-vitals"
  | "crawl-links";

export interface EvidenceClaimField {
  path: string;
  capability: EvidenceCapability;
  metric: string;
}

export interface SeoEvidence {
  id: string;
  source: EvidenceSource;
  property: string;
  filters: Record<string, string | null>;
  dateRange: { startDate: string | null; endDate: string | null };
  freshness: string;
  rows: unknown[];
  claimFields: EvidenceClaimField[];
  limitation?: string;
}

type ClaimKind = "Fact" | "Calculation" | "Inference" | "Recommendation";

interface EvidencePointer {
  id: string;
  path: string;
}

interface StructuredClaim {
  kind: ClaimKind;
  text: string;
  capability: EvidenceCapability;
  metric?: string;
  evidence: EvidencePointer[];
  calculation?: {
    formula: string;
    inputs: EvidencePointer[];
  };
}

interface StructuredAnswer {
  claims: StructuredClaim[];
}

const RENDERED_CITATION_RE = /\[([A-Z][A-Z0-9-]{1,80})#([A-Za-z0-9_.-]{1,180})\]/g;
const NUMBER_TOKEN_RE = /[-+]?(?:\d[\d,]*\.?\d*|\.\d+)%?/g;
const KINDS = new Set<ClaimKind>(["Fact", "Calculation", "Inference", "Recommendation"]);
const CAPABILITIES = new Set<EvidenceCapability>([
  "search-performance",
  "analytics",
  "bing-performance",
  "sitemap-indexing",
  "url-index-status",
  "bing-indexing",
  "copilot-citations",
  "core-web-vitals",
  "crawl-links",
]);

export const SAFE_GROUNDING_REFUSAL =
  "**Fact:** I couldn't produce a fully grounded answer from the available evidence, so no SEO claim has been shown.\n\n" +
  "**Recommendation:** Narrow the question to one available source, page, metric, or date range and try again.";

export function citedEvidenceIds(answer: string): string[] {
  return [...new Set(Array.from(answer.matchAll(RENDERED_CITATION_RE), (match) => match[1]!))];
}

export function validateGroundedAnswer(
  answer: string,
  evidence: SeoEvidence[],
): { ok: true; citedIds: string[]; answer: string } | { ok: false; errors: string[]; citedIds: string[] } {
  const parsed = parseStructuredAnswer(answer);
  if (!parsed) return { ok: false, errors: ["invalid_structured_answer"], citedIds: [] };

  const byId = new Map(evidence.map((item) => [item.id, item]));
  const citedIds = new Set<string>();
  const errors: string[] = [];

  if (parsed.claims.length === 0 || parsed.claims.length > 24) {
    errors.push("invalid_claim_count");
  }

  parsed.claims.forEach((claim, claimIndex) => {
    if (!claim || typeof claim !== "object") {
      errors.push(`claim_${claimIndex}_invalid`);
      return;
    }
    if (!KINDS.has(claim.kind) || typeof claim.text !== "string" || !claim.text.trim()) {
      errors.push(`claim_${claimIndex}_shape_invalid`);
      return;
    }
    if (!CAPABILITIES.has(claim.capability)) {
      errors.push(`claim_${claimIndex}_capability_invalid`);
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`claim_${claimIndex}_evidence_missing`);
      return;
    }

    const resolved = claim.evidence
      .map((pointer, pointerIndex) => validatePointer(pointer, byId, claimIndex, pointerIndex, errors))
      .filter((item): item is ResolvedPointer => item !== null);
    for (const item of resolved) citedIds.add(item.record.id);

    if (!resolved.some((item) => item.field.capability === claim.capability)) {
      errors.push(`claim_${claimIndex}_capability_not_supported`);
    }

    if (claim.kind === "Fact" || claim.kind === "Calculation") {
      if (typeof claim.metric !== "string" || !claim.metric.trim()) {
        errors.push(`claim_${claimIndex}_metric_required`);
      } else if (!resolved.some((item) =>
        item.field.capability === claim.capability && item.field.metric === claim.metric
      )) {
        errors.push(`claim_${claimIndex}_metric_not_supported`);
      } else if (!metricNamedInText(claim.metric, claim.text)) {
        errors.push(`claim_${claimIndex}_metric_not_named`);
      }
    } else if (
      claim.metric &&
      !resolved.some((item) =>
        item.field.capability === claim.capability && item.field.metric === claim.metric
      )
    ) {
      errors.push(`claim_${claimIndex}_metric_not_supported`);
    }

    validateNamedSource(claim, resolved, claimIndex, errors);
    validateCapabilityLanguage(claim, resolved, claimIndex, errors);
    validateNumbers(claim.text, resolved, claimIndex, errors);

    if (claim.kind === "Calculation") {
      const calculation = claim.calculation;
      if (
        !calculation ||
        typeof calculation.formula !== "string" ||
        !calculation.formula.trim() ||
        !Array.isArray(calculation.inputs) ||
        calculation.inputs.length < 2
      ) {
        errors.push(`claim_${claimIndex}_calculation_inputs_missing`);
      } else {
        const inputs = calculation.inputs
          .map((pointer, pointerIndex) =>
            validatePointer(pointer, byId, claimIndex, pointerIndex, errors, "calculation_input")
          )
          .filter((item): item is ResolvedPointer => item !== null);
        for (const item of inputs) citedIds.add(item.record.id);
        if (inputs.length < 2) errors.push(`claim_${claimIndex}_calculation_inputs_invalid`);
      }
    } else if (claim.calculation !== undefined) {
      errors.push(`claim_${claimIndex}_unexpected_calculation`);
    }
  });

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)], citedIds: [...citedIds] };
  return {
    ok: true,
    citedIds: [...citedIds],
    answer: renderClaims(parsed.claims),
  };
}

interface ResolvedPointer {
  record: SeoEvidence;
  field: EvidenceClaimField;
  value: unknown;
  pointer: EvidencePointer;
}

function parseStructuredAnswer(answer: string): StructuredAnswer | null {
  if (!answer.trim()) return null;
  try {
    const raw = JSON.parse(answer) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as StructuredAnswer).claims)) return null;
    return raw as StructuredAnswer;
  } catch {
    return null;
  }
}

function validatePointer(
  pointer: EvidencePointer,
  byId: Map<string, SeoEvidence>,
  claimIndex: number,
  pointerIndex: number,
  errors: string[],
  prefix = "evidence",
): ResolvedPointer | null {
  if (
    !pointer ||
    typeof pointer !== "object" ||
    typeof pointer.id !== "string" ||
    typeof pointer.path !== "string"
  ) {
    errors.push(`claim_${claimIndex}_${prefix}_${pointerIndex}_invalid`);
    return null;
  }
  const record = byId.get(pointer.id);
  if (!record) {
    errors.push(`claim_${claimIndex}_${prefix}_${pointerIndex}_unknown_id`);
    return null;
  }
  const field = record.claimFields.find((candidate) => pathMatches(candidate.path, pointer.path));
  if (!field) {
    errors.push(`claim_${claimIndex}_${prefix}_${pointerIndex}_field_not_allowed`);
    return null;
  }
  const found = resolvePath({ rows: record.rows }, pointer.path);
  if (!found.exists) {
    errors.push(`claim_${claimIndex}_${prefix}_${pointerIndex}_field_missing`);
    return null;
  }
  return { record, field, value: found.value, pointer };
}

function pathMatches(pattern: string, actual: string): boolean {
  const p = pattern.split(".");
  const a = actual.split(".");
  const match = (pi: number, ai: number): boolean => {
    if (pi === p.length) return ai === a.length;
    if (p[pi] === "**") return match(pi + 1, ai) || (ai < a.length && match(pi, ai + 1));
    if (ai >= a.length || (p[pi] !== "*" && p[pi] !== a[ai])) return false;
    return match(pi + 1, ai + 1);
  };
  return match(0, 0);
}

function resolvePath(root: unknown, path: string): { exists: boolean; value: unknown } {
  let value = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return { exists: false, value: undefined };
      value = value[index];
    } else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, segment)) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return { exists: false, value: undefined };
    }
  }
  return { exists: true, value };
}

function validateNamedSource(
  claim: StructuredClaim,
  resolved: ResolvedPointer[],
  claimIndex: number,
  errors: string[],
): void {
  const rules: Array<[RegExp, EvidenceSource, string]> = [
    [/\b(?:gsc|search console|google search)\b/i, "Google Search Console", "gsc"],
    [/\b(?:ga4|google analytics)\b/i, "Google Analytics 4", "ga4"],
    [/\bbing\b/i, "Bing Webmaster", "bing"],
    [/\b(?:crux|chrome ux)\b/i, "Chrome UX Report", "crux"],
    [/\b(?:crawl|internal links?)\b/i, "Site crawl", "crawl"],
  ];
  for (const [pattern, source, key] of rules) {
    if (pattern.test(claim.text) && !resolved.some((item) => item.record.source === source)) {
      errors.push(`claim_${claimIndex}_${key}_source_mismatch`);
    }
  }
}

function validateCapabilityLanguage(
  claim: StructuredClaim,
  resolved: ResolvedPointer[],
  claimIndex: number,
  errors: string[],
): void {
  const requirements: Array<[RegExp, EvidenceCapability, string]> = [
    [/\bcopilot\b/i, "copilot-citations", "copilot"],
    [/\bbing\b.{0,30}\b(?:index|indexed|indexing)\b|\b(?:index|indexed|indexing)\b.{0,30}\bbing\b/i, "bing-indexing", "bing_indexing"],
    [/\b(?:this|the|selected)\s+page\s+(?:is|isn't|is not|was|wasn't|was not)\s+indexed\b/i, "url-index-status", "url_index_status"],
    [/\b(?:core web vitals?|crux|lcp|inp|cls)\b/i, "core-web-vitals", "core_web_vitals"],
    [/\b(?:ga4|google analytics|sessions?|engagement rate|key events?|ai referrals?)\b/i, "analytics", "analytics"],
    [/\b(?:crawl|internal links?|anchor text)\b/i, "crawl-links", "crawl"],
  ];
  for (const [pattern, capability, key] of requirements) {
    if (
      pattern.test(claim.text) &&
      !resolved.some((item) => item.field.capability === capability)
    ) {
      errors.push(`claim_${claimIndex}_${key}_capability_mismatch`);
    }
  }
}

function validateNumbers(
  text: string,
  resolved: ResolvedPointer[],
  claimIndex: number,
  errors: string[],
): void {
  const prose = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b\d{4}\b/g, "");
  const values = resolved.flatMap((item) => numericValues(item.value));
  for (const token of prose.match(NUMBER_TOKEN_RE) ?? []) {
    const numeric = Number(token.replace(/[% ,]/g, ""));
    if (!Number.isFinite(numeric)) continue;
    const supported = values.some((value) =>
      Math.abs(value - numeric) < 0.000_001 ||
      (token.endsWith("%") && Math.abs(value * 100 - numeric) < 0.01)
    );
    if (!supported) errors.push(`claim_${claimIndex}_numeric_value_not_supported`);
  }
}

function metricNamedInText(metric: string, text: string): boolean {
  const patterns: Record<string, RegExp> = {
    clicks: /\bclicks?\b/i,
    impressions: /\bimpressions?\b/i,
    ctr: /\b(?:ctr|click-through rate)\b/i,
    position: /\b(?:position|rank(?:ing)?)\b/i,
    "clicks-change": /\bclicks?\b/i,
    "impressions-change": /\bimpressions?\b/i,
    "ctr-change": /\b(?:ctr|click-through rate)\b/i,
    "position-change": /\b(?:position|rank(?:ing)?)\b/i,
    sessions: /\bsessions?\b/i,
    "engagement-rate": /\bengagement rate\b/i,
    "average-engagement-time": /\b(?:average )?engagement time\b/i,
    "key-events": /\b(?:key events?|conversions?)\b/i,
    "ai-referral-sessions": /\b(?:ai referrals?|ai sessions?)\b/i,
    "sitemap-submitted": /\b(?:submitted|sitemap)\b/i,
    "sitemap-indexed": /\b(?:indexed|sitemap)\b/i,
    "sitemap-errors": /\b(?:errors?|sitemap)\b/i,
    "sitemap-index-coverage": /\b(?:coverage|indexed|sitemap)\b/i,
    "sitemap-not-indexed": /\b(?:not indexed|sitemap)\b/i,
    "cwv-metric": /\b(?:core web vitals?|crux|lcp|inp|cls)\b/i,
    "cwv-p75": /\b(?:p75|75th percentile|core web vitals?|crux|lcp|inp|cls)\b/i,
    "cwv-band": /\b(?:good|needs improvement|poor|band|core web vitals?|crux|lcp|inp|cls)\b/i,
    "inbound-links": /\b(?:inbound|incoming|internal links?)\b/i,
    "outbound-links": /\b(?:outbound|outgoing|internal links?)\b/i,
    "anchor-text": /\banchor text\b/i,
    "link-source": /\b(?:source page|links? from|internal links?)\b/i,
    query: /\b(?:query|keyword)\b/i,
    page: /\b(?:page|url)\b/i,
    "result-key": /\b(?:query|keyword|page|url)\b/i,
    "landing-page": /\b(?:landing page|page|url)\b/i,
    "bucket-date": /\b(?:week|bucket|date)\b/i,
    "form-factor": /\b(?:mobile|desktop|tablet|form factor)\b/i,
    "sitemap-path": /\b(?:sitemap|path|url)\b/i,
  };
  const pattern = patterns[metric];
  if (pattern) return pattern.test(text);
  return metric
    .split("-")
    .filter((token) => token.length > 2)
    .some((token) => new RegExp(`\\b${escapeRegExp(token)}s?\\b`, "i").test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numericValues(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (typeof value === "string") {
    return (value.match(NUMBER_TOKEN_RE) ?? [])
      .map((token) => Number(token.replace(/[% ,]/g, "")))
      .filter(Number.isFinite);
  }
  if (Array.isArray(value)) return value.flatMap(numericValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(numericValues);
  return [];
}

function renderClaims(claims: StructuredClaim[]): string {
  return claims.map((claim) => {
    const pointers = [
      ...claim.evidence,
      ...(claim.calculation?.inputs ?? []),
    ];
    const citations = [...new Map(
      pointers.map((pointer) => [`${pointer.id}#${pointer.path}`, pointer] as const),
    ).values()]
      .map((pointer) => `[${pointer.id}#${pointer.path}]`)
      .join(" ");
    return `**${claim.kind}:** ${claim.text.trim()} ${citations}`;
  }).join("\n\n");
}

export function evidenceForClient(evidence: SeoEvidence[], citedIds: string[]): SeoEvidence[] {
  const cited = new Set(citedIds);
  return evidence.filter((item) => cited.has(item.id));
}