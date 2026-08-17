/**
 * Rule-based search-query intent classifier.
 *
 * Deterministic and auditable (no LLM): classifies a query into
 *  - "bofu"          — transactional / navigational / ready-to-use intent
 *  - "commercial"    — buying research: comparisons, category browsing, vendors
 *  - "informational" — everything else (how-to, what-is, concepts, trends)
 *
 * Precedence: junk-operator → brand/site: → conversion terms → comparison /
 * superlative → service/agency → buying-research question → plural category →
 * singular tool/product → informational.
 * Key fine line: singular "X tool" = bofu, plural "X tools" = commercial.
 */

export type QueryIntent = "bofu" | "commercial" | "informational";

const BRAND_TERMS = (process.env["GSC_BRAND_TERMS"] ?? "wellows")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

/** AI-scraper style operator queries that pollute GSC top-N — never real demand. */
const JUNK_OPERATOR_RE =
  /(^|\s)(intitle:|inurl:|allintitle:|allinurl:|filetype:|related:|cache:)|["“”]{2}/;

const CONVERSION_RE =
  /\b(demo|trial|sign ?up|signup|log ?in|login|pricing|price|prices|cost|buy|purchase|subscribe|subscription|free trial|book a demo|get started|discount|coupon)\b/;

const COMPARISON_RE =
  /\b(best|top \d*|vs\.?|versus|alternative|alternatives|review|reviews|comparison|compare|compared)\b|(^|\s)top\s/;

const SERVICE_RE =
  /\b(agency|agencies|consultant|consultants|consulting|service|services|vendor|vendors|company|companies|firm|firms|startup|startups|expert|experts|freelancer|freelancers)\b/;

const QUESTION_RE =
  /^(what|which|who|how do i (choose|pick|find|select)|is there a)\b.*\b(tool|tools|software|platform|platforms|solution|solutions|product|products)\b/;

const PLURAL_CATEGORY_RE =
  /\b(tools|softwares|platforms|solutions|products|apps|trackers|checkers|generators|audits)\b/;

const SINGULAR_TOOL_RE =
  /\b(tool|software|platform|app|checker|tracker|monitor|audit|analyzer|analyser|generator|detector|scanner|calculator|grader|tester|dashboard|api)\b/;

export function isJunkOperatorQuery(query: string): boolean {
  return JUNK_OPERATOR_RE.test(query.toLowerCase());
}

export function classifyQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  // Brand / navigational → bofu (site: queries only count when they carry the brand).
  const isSiteOp = q.includes("site:");
  const isBranded = BRAND_TERMS.some((t) => q.includes(t));
  if (isBranded) return "bofu";
  if (isSiteOp) return "informational"; // non-brand site: operator query — scraper junk

  if (CONVERSION_RE.test(q)) return "bofu";
  if (COMPARISON_RE.test(q)) return "commercial";
  if (SERVICE_RE.test(q)) return "commercial";
  if (QUESTION_RE.test(q)) return "commercial";
  if (PLURAL_CATEGORY_RE.test(q)) return "commercial";
  if (SINGULAR_TOOL_RE.test(q)) return "bofu";

  return "informational";
}
