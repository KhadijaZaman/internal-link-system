import OpenAI from "openai";
import type { BriefInput } from "./claude";
import { fetchPageHtmlInHouse, type FetchedHtml } from "./htmlFetch";
import {
  extractOutlineFromHtml,
  extractNgramSet,
  generateEntities,
  extractEntitiesFromText,
  generateNlpKeywords,
  generateSkipGrams,
  generateGrammar,
  type OutlineNode,
  type NgramHit,
  type GrammarOntology,
} from "./semanticPipeline";
import {
  KHADIJA_SYSTEM_PROMPT,
  KORAY_SEO_RULES,
  runQualityGate,
  formatQualityGateMarkdown,
} from "./voice/khadija";
import { logger } from "../lib/logger";
import { retrieveKbGrounding } from "../services/kbGrounding";

/**
 * Phase 1 brief generator.
 *
 * Pipeline:
 *   1. Pick the primary target query from GSC buckets (top impressions).
 *   2. Pull up to 5 competitor URLs from the SERP `competitors` field.
 *   3. Fetch competitor pages (in-house; fail-soft per URL).
 *   4. Run the 7-step research pipeline in parallel:
 *        outlines, n-grams, AI entities, competitor entities, NLP keywords,
 *        skip-grams, grammar ontology.
 *   5. Build a master prompt that injects GSC perf + research signals +
 *      Khadija voice system prompt + Koray SEO rules.
 *   6. Generate the brief once with gpt-4o-mini.
 *   7. Run the Khadija quality gate (deterministic linter + LLM structure
 *      pass) and append a "## Quality Gate" markdown block to the brief.
 *
 * The brief is still on-demand only — no cron — per scheduler.ts.
 */

export const BRIEF_MODEL = "gpt-4o-mini";

function getClient(): OpenAI {
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is required for brief generation. Set it in the environment.",
    );
  }
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) > 127) {
      throw new Error(
        `OPENAI_API_KEY contains a non-ASCII character at position ${i}. ` +
          `Re-paste the key directly from https://platform.openai.com/api-keys.`,
      );
    }
  }
  return new OpenAI({ apiKey: key });
}

interface GscRow {
  query?: string;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SerpItem {
  position?: number;
  title?: string;
  url?: string;
  domain?: string;
}

function pickPrimaryQuery(input: BriefInput): string {
  // Operator-entered target keywords are authoritative — prefer the first one
  // over the highest-impression GSC query when present.
  const operatorTarget = (input.targetKeywords ?? [])
    .map((k) => k.trim())
    .find((k) => k.length > 0);
  if (operatorTarget) return operatorTarget;
  const all: GscRow[] = [
    ...(Array.isArray(input.buckets.top3) ? (input.buckets.top3 as GscRow[]) : []),
    ...(Array.isArray(input.buckets.pos4_10) ? (input.buckets.pos4_10 as GscRow[]) : []),
    ...(Array.isArray(input.buckets.pos11_20) ? (input.buckets.pos11_20 as GscRow[]) : []),
    ...(Array.isArray(input.buckets.pos21plus) ? (input.buckets.pos21plus as GscRow[]) : []),
  ];
  const sorted = all
    .filter((r): r is GscRow & { query: string } => typeof r.query === "string")
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));
  return sorted[0]?.query ?? (input.h1 || input.title || "the target topic");
}

function extractCompetitorUrls(input: BriefInput, ownUrl: string, max = 5): string[] {
  const set = new Set<string>();
  const ownHost = (() => { try { return new URL(ownUrl).hostname; } catch { return ""; } })();
  const competitors = input.competitors as Record<string, SerpItem[] | undefined>;
  for (const arr of Object.values(competitors ?? {})) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const u = item.url;
      if (!u) continue;
      try {
        const host = new URL(u).hostname;
        if (host && host !== ownHost) set.add(u);
      } catch { /* skip bad URLs */ }
      if (set.size >= max) return [...set];
    }
  }
  return [...set];
}

async function fetchCompetitorPages(urls: string[]): Promise<FetchedHtml[]> {
  const results = await Promise.allSettled(urls.map((u) => fetchPageHtmlInHouse(u)));
  const out: FetchedHtml[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      out.push(r.value);
    } else {
      logger.warn({ url: urls[i], err: r.reason }, "Competitor page fetch failed (brief pipeline)");
    }
  }
  return out;
}

function formatOutlines(outlines: { url: string; outline: OutlineNode[] }[]): string {
  if (outlines.length === 0) return "(no competitor outlines extracted)";
  return outlines.map(({ url, outline }) => {
    const lines = outline.slice(0, 25).map((n) => `${"  ".repeat(Math.max(0, n.level - 1))}H${n.level}: ${n.text}`);
    return `### ${url}\n${lines.join("\n")}`;
  }).join("\n\n");
}

function formatNgrams(ngrams: Record<string, NgramHit[]>): string {
  return Object.entries(ngrams).map(([k, hits]) => {
    const top = hits.slice(0, 15).map((h) => `${h.phrase} (×${h.count})`).join(", ");
    return `- ${k}: ${top || "(none)"}`;
  }).join("\n");
}

function formatGrammar(g: GrammarOntology): string {
  const fmt = (label: string, items: string[]) => `- ${label}: ${items.join(", ") || "(none)"}`;
  return [
    fmt("proper nouns", g.properNouns),
    fmt("common nouns", g.commonNouns),
    fmt("synonyms", g.synonyms),
    fmt("antonyms", g.antonyms),
    fmt("hyponyms (sub-types)", g.hyponyms),
    fmt("hypernyms (parents)", g.hypernyms),
    fmt("meronyms (components)", g.meronyms),
    fmt("holonyms (part of)", g.holonyms),
  ].join("\n");
}

export async function generateBrief(input: BriefInput): Promise<string> {
  const client = getClient();
  const primaryQuery = pickPrimaryQuery(input);
  const competitorUrls = extractCompetitorUrls(input, input.targetUrl, 5);

  const operatorTargetKeywords = (input.targetKeywords ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, 20);
  const targetKeywordsBlock = operatorTargetKeywords.length
    ? `\n\n═══ OPERATOR TARGET KEYWORDS (authoritative — these reflect operator intent; prioritise over GSC-derived picks) ═══\n${operatorTargetKeywords.join(", ")}`
    : "";

  logger.info(
    { targetUrl: input.targetUrl, primaryQuery, competitorCount: competitorUrls.length },
    "Brief pipeline: starting research layer",
  );

  // 1) Fetch competitor pages
  const competitorPages = await fetchCompetitorPages(competitorUrls);
  const competitorText = competitorPages.map((p) => p.bodyText).join("\n\n").slice(0, 80000);
  const outlines = competitorPages.map((p) => ({
    url: p.url,
    outline: extractOutlineFromHtml(p.rawHtml),
  }));

  // 2) Research pipeline in parallel
  const [ngrams, aiEntities, competitorEntities, nlpKeywords, skipGrams, grammar, kbGrounding] = await Promise.all([
    Promise.resolve(extractNgramSet(competitorPages.map((p) => p.bodyText))),
    generateEntities(primaryQuery),
    extractEntitiesFromText(competitorText),
    generateNlpKeywords(primaryQuery),
    generateSkipGrams(primaryQuery),
    generateGrammar(primaryQuery),
    retrieveKbGrounding(`${primaryQuery} ${input.title} ${input.h1}`),
  ]);

  const kbGroundingBlock = kbGrounding
    ? `\n\n═══ KORAY TRANSCRIPT GROUNDING (operator knowledge base — apply these semantic-SEO principles and cite them where relevant) ═══\n${kbGrounding}`
    : "";

  logger.info(
    {
      ngrams: Object.fromEntries(Object.entries(ngrams).map(([k, v]) => [k, v.length])),
      aiEntities: aiEntities.length,
      competitorEntities: competitorEntities.length,
      nlpKeywords: nlpKeywords.length,
      skipGrams: skipGrams.length,
    },
    "Brief pipeline: research layer complete",
  );

  // 3) Master prompt
  const master = `Write an SEO optimization brief for Wellows, an AI-visibility SaaS that tracks brand citations in ChatGPT, Gemini, Perplexity, AI Overviews, and AI Mode. The brief is written by Khadija Zaman, SEO/AEO/GEO Manager at Wellows. Apply Koray Tugberk Gubur's semantic SEO framework throughout.

WELLOWS CENTRAL ENTITY: AI visibility. Four moats:
1. Explicit + implicit citation tracking
2. Outreach layer for citation acquisition
3. Content optimization tied to citation impact
4. 485K-citation research dataset

═══ TARGET PAGE ═══
URL: ${input.targetUrl}
Title: ${input.title || "(missing)"}
H1: ${input.h1 || "(missing)"}
Operator notes: ${input.notes || "(none)"}
Primary target query (canonical): "${primaryQuery}"${targetKeywordsBlock}

═══ CURRENT BODY EXCERPT ═══
${input.bodyExcerpt.slice(0, 6000) || "(no body text fetched)"}

═══ GSC PERFORMANCE (last 90 days, grouped by position) ═══
Top 3: ${JSON.stringify(input.buckets.top3)}
Positions 4-10: ${JSON.stringify(input.buckets.pos4_10)}
Positions 11-20: ${JSON.stringify(input.buckets.pos11_20)}
Positions 21+: ${JSON.stringify(input.buckets.pos21plus)}

═══ INTERNAL LINKS ═══
Inbound (${input.inbound.length}): ${JSON.stringify(input.inbound.slice(0, 10))}
Outbound (${input.outbound.length}): ${JSON.stringify(input.outbound.slice(0, 10))}

═══ COMPETITOR OUTLINES (top SERP, H1-H4) ═══
${formatOutlines(outlines)}

═══ COMPETITOR N-GRAMS (frequency-analyzed dominant phrases) ═══
${formatNgrams(ngrams)}

═══ AI-GENERATED ENTITIES TO COVER (${aiEntities.length}) ═══
${aiEntities.join(", ") || "(none generated)"}

═══ ENTITIES EXTRACTED FROM COMPETITORS (${competitorEntities.length}) ═══
${competitorEntities.join(", ") || "(none extracted)"}

═══ NLP / LSI KEYWORDS (${nlpKeywords.length}) ═══
${nlpKeywords.join(", ") || "(none generated)"}

═══ SKIP-GRAM DOMINANT WORD PAIRS (${skipGrams.length}) ═══
${skipGrams.join(", ") || "(none generated)"}

═══ SEMANTIC GRAMMAR ONTOLOGY ═══
${formatGrammar(grammar)}${kbGroundingBlock}

═══ SERP CONTEXT ═══
Top 5 SERP per highest-impression queries: ${JSON.stringify(input.competitors)}

═══ DELIVERABLE ═══
Produce a Khadija-voice markdown brief with these sections. Each section is concrete and cites specific data above — no filler, no hedging without naming the limit.

# Optimization Brief: ${input.targetUrl}

## Diagnosis
2-3 sentences on what is currently happening with this page. Reference specific GSC numbers (clicks, impressions, position). Open with a specific finding from the data above, not a topic statement.

## Primary Target Query (canonical)
The one query this page should own. Justify with one number from GSC.

## Koray Contextual Structure (proposed H2/H3 hierarchy)
List H2 and H3 headings. For each: state the entity-attribute pair it covers (cite from the entity list above) and 1-line on intended content. Make claims, not categories.

## Entity & Attribute Coverage Gaps
Compare entities the page should cover (AI-generated list + competitor list) against what is currently in the body excerpt. List the missing entities concretely. Reference the n-grams above where competitors dominate.

## NLP & N-Gram Targets
List the specific NLP keywords and 2-3-gram phrases this page should add to the body, drawn from the lists above. Be specific — 5-8 phrases max, each with one-sentence placement guidance.

## Internal Link Actions
- Pages that should link TO this page (anchor text must match this page's H1)
- Pages this page should link FROM (Outer→Core direction if applicable)

## SERP-Driven Content Adds
Reference the competitor outlines above. Name 2-3 specific sections competitors have that this page does not. Recommend whether to add them, with one-line reasoning.

## EEAT Additions
Wellows-specific trust signals: Khadija Zaman byline (SEO/AEO/GEO Manager at Wellows), 485K-citation dataset reference where it fits naturally, customer testimonials.

## 7-Day Action List
Numbered list of concrete edits to ship this week. Each item starts with a verb and names a specific URL or section.

VOICE NON-NEGOTIABLES (re-read system prompt):
- Open the Diagnosis with a specific-finding opener, not a topic statement.
- Use Khadija's attribution style (named source + specific concept). If you reference Koray, Mike King, or other practitioners, name them.
- Vary sentence length within paragraphs.
- No banned hype words. No weasel hedges. No engagement bait.
- Where a visual would help (comparison table, before/after, SERP screenshot), mark inline as [VISUAL: short description].`;

  // 4) Generate brief
  const res = await client.chat.completions.create({
    model: BRIEF_MODEL,
    max_tokens: 4000,
    messages: [
      { role: "system", content: `${KHADIJA_SYSTEM_PROMPT}\n\n${KORAY_SEO_RULES}` },
      { role: "user", content: master },
    ],
  });
  const brief = res.choices[0]?.message?.content ?? "";
  if (!brief) {
    logger.warn({ targetUrl: input.targetUrl }, "Brief pipeline: empty completion from OpenAI");
    return "";
  }

  // 5) Quality gate
  const gate = await runQualityGate(brief, client, BRIEF_MODEL);
  logger.info(
    { targetUrl: input.targetUrl, total: gate.total, verdict: gate.verdict, violations: gate.violations.length },
    "Brief pipeline: quality gate complete",
  );

  return `${brief}\n\n---\n\n${formatQualityGateMarkdown(gate)}`;
}
