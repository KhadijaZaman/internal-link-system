import type { SeoEvidence } from "./gscEvidence";

export type SeoCapability =
  | "search-performance"
  | "analytics"
  | "bing-performance"
  | "crawl-links"
  | "copilot-citations"
  | "semantic"
  | "topical-map"
  | "paid-scan"
  | "market-filter";

export interface QuestionRoute {
  capabilities: SeoCapability[];
  directAnswer?: string;
}

export function routeSeoQuestion(question: string, evidence: SeoEvidence[]): QuestionRoute {
  const q = question.toLowerCase();
  const capabilities = new Set<SeoCapability>();
  if (/\b(gsc|search console|clicks?|impressions?|ctr|position|rank|queries?|keywords?)\b/.test(q)) capabilities.add("search-performance");
  if (/\b(ga4|analytics|sessions?|engagement|conversions?|key events?|ai referrals?)\b/.test(q)) capabilities.add("analytics");
  if (/\bbing\b/.test(q)) capabilities.add("bing-performance");
  if (/\b(internal links?|anchor text|crawl)\b/.test(q)) capabilities.add("crawl-links");
  if (/\b(copilot(?: citations?)?|bing ai (?:citations?|performance)|grounding quer(?:y|ies))\b/.test(q)) capabilities.add("copilot-citations");
  if (/\b(semantic|embedding|cosine|related pages?|similar content)\b/.test(q)) capabilities.add("semantic");
  if (/\b(topical map|topic cluster|content gap|competitor gap)\b/.test(q)) capabilities.add("topical-map");
  if (/\b(run|start|buy|purchase|refresh)\b.{0,30}\b(scan|dataforseo|competitor)\b/.test(q)) capabilities.add("paid-scan");
  if (/\b(country|market|region|united states|usa|uk|canada|australia|india)\b/.test(q)) capabilities.add("market-filter");

  if (capabilities.has("paid-scan")) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** Ask AI has not started a paid scan. Paid scans require your explicit confirmation before any billable request is made.\n\n" +
        "**Recommendation:** Confirm the exact scan and market you want to run, then start it from the relevant scan workflow.",
    };
  }
  if (capabilities.has("copilot-citations") && !evidence.some((item) => item.id.startsWith("COPILOT-"))) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** Copilot citation evidence is not present in this Ask AI slice. Bing Webmaster clicks and impressions, Bing indexing, GA4 AI-referral sessions, and Copilot citations are separate datasets.\n\n" +
        "**Recommendation:** Import or open the Bing AI Performance citation report before asking for Copilot citation conclusions.",
    };
  }
  if (capabilities.has("semantic") && !evidence.some((item) => item.id.startsWith("SEMANTIC-"))) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** Semantic similarity evidence is not available in this Ask AI session, so I cannot support a similarity or embedding claim.\n\n" +
        "**Recommendation:** Open the semantic linking report or run its separately confirmed analysis first.",
    };
  }
  if (capabilities.has("topical-map") && !evidence.some((item) => item.id.startsWith("TOPICAL-"))) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** Topical-map and competitor-gap evidence is not available in this Ask AI session.\n\n" +
        "**Recommendation:** Use the topical-map report for that question. If it needs a paid competitor refresh, confirm that scan there first.",
    };
  }
  if (capabilities.has("market-filter")) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** This Ask AI slice is filtered to all available countries, not the market named in the question. I will not present all-country metrics as market-specific evidence.\n\n" +
        "**Recommendation:** Apply the market in the GSC geography report, then ask from a market-scoped evidence slice when that filter is available here.",
    };
  }
  if (capabilities.has("crawl-links") && !evidence.some((item) => item.source === "Site crawl")) {
    return {
      capabilities: [...capabilities],
      directAnswer:
        "**Fact:** Crawl and internal-link evidence is only loaded when a page on this site is selected. It is missing from this session.\n\n" +
        "**Recommendation:** Select the page in the URL filter and ask again.",
    };
  }
  return { capabilities: [...capabilities] };
}