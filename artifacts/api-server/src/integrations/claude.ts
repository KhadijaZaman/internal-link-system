import { anthropic } from "@workspace/integrations-anthropic-ai";

export { anthropic };

export const SUGGESTION_MODEL = "claude-haiku-4-5";
export const BRIEF_MODEL = "claude-sonnet-4-6";

export const SUGGESTION_SYSTEM = `You are placing an internal link on a Wellows blog page following Koray Tugberk Gubur's semantic SEO rules. Wellows is an AI visibility SaaS that tracks brand citations across ChatGPT, Gemini, Perplexity, AI Overviews, and AI Mode.

Voice rules (non-negotiable):
- Conversational casual, plain vocabulary
- Confident, not hedgy
- No emojis, no GPT-style openers ("In today's...", "Let's dive in")
- Banned hype words: seamless, unlock, leverage, robust, cutting-edge, game-changer, supercharge
- Short sentences, no em-dash decoration

Koray rules:
1. Lecture #73: Place link AFTER the concept is defined. Never on the first word of a sentence.
2. Lecture #74: Anchor text must exactly match the target page's H1.`;

export interface SuggestionInput {
  donorBody: string;
  receiverUrl: string;
  receiverH1: string;
  anchorText: string;
}

export interface SuggestionResult {
  insertionParagraph: string;
  whyThisFits: string;
}

export async function generateSuggestion(
  input: SuggestionInput,
): Promise<SuggestionResult | null> {
  const user = `DONOR PAGE BODY (where the link will go):
${input.donorBody.slice(0, 6000)}

LINK TARGET:
- URL: ${input.receiverUrl}
- Target H1: ${input.receiverH1}
- Anchor text (must match H1): "${input.anchorText}"

Return JSON only, no preamble:
{
  "insertion_paragraph": "the existing paragraph from the donor page where the link fits naturally, with the anchor replaced by <a href=DUMMY>${input.anchorText}</a>",
  "why_this_fits": "one sentence on why this placement satisfies Koray's rules"
}`;

  const msg = await anthropic.messages.create({
    model: SUGGESTION_MODEL,
    max_tokens: 800,
    system: SUGGESTION_SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  const text = block.text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      insertion_paragraph?: string;
      why_this_fits?: string;
    };
    if (!parsed.insertion_paragraph) return null;
    return {
      insertionParagraph: parsed.insertion_paragraph.replace(
        /DUMMY/g,
        input.receiverUrl,
      ),
      whyThisFits: parsed.why_this_fits ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Contextual Relevance Soft-check (CRS) per SOP §7.2 step 1.
 *
 * Asks Claude Haiku to confirm that a proposed donor→target link is
 * factually consistent and topically appropriate. The check is a soft gate:
 * proposals that fail are skipped, but a low-confidence yes is allowed
 * through. Designed to be called sparingly (top-N proposals only) since it
 * spends tokens.
 *
 * Returns `{ keep, reason }`. `keep === true` with a non-error reason means
 * the link passed; any other shape (parse error, API error, no-response) is
 * surfaced via `reason` so the CALLER can decide whether to fail-open or
 * fail-closed. The semantic linking job currently treats CRS as a fail-closed
 * gate — any non-affirmative response drops the proposal.
 */
export interface CrsVerdict {
  /** True only when the model returned a parseable JSON object with `keep: true`. */
  keep: boolean;
  /** True when we got an explicit, parseable decision (either keep=true OR keep=false). False on parse/API/no-response errors. */
  decided: boolean;
  reason: string;
}

export async function checkContextualConsistency(input: {
  donorExcerpt: string;
  targetUrl: string;
  targetH1: string;
  anchorText: string;
}): Promise<CrsVerdict> {
  const user = `You are checking whether placing an internal link is factually consistent and topically appropriate.

DONOR PAGE EXCERPT (where the link will go):
${input.donorExcerpt.slice(0, 2500)}

PROPOSED LINK:
- Anchor text: "${input.anchorText}"
- Target URL: ${input.targetUrl}
- Target page H1: ${input.targetH1}

Rules:
- Reject if the donor passage makes a claim that contradicts what the target page is about.
- Reject if the topical overlap is weak — the link would feel forced.
- Accept if the link adds genuine context for a reader of the donor page.

Reply JSON only: {"keep": true|false, "reason": "<one short sentence>"}`;

  try {
    const msg = await anthropic.messages.create({
      model: SUGGESTION_MODEL,
      max_tokens: 120,
      messages: [{ role: "user", content: user }],
    });
    const block = msg.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return { keep: false, decided: false, reason: "no-response" };
    }
    const m = block.text.match(/\{[\s\S]*\}/);
    if (!m) return { keep: false, decided: false, reason: "no-json" };
    let parsed: { keep?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(m[0]) as { keep?: unknown; reason?: unknown };
    } catch {
      return { keep: false, decided: false, reason: "parse-error" };
    }
    if (typeof parsed.keep !== "boolean") {
      return { keep: false, decided: false, reason: "missing-keep" };
    }
    return {
      keep: parsed.keep,
      decided: true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return { keep: false, decided: false, reason: "crs-error" };
  }
}

export interface BriefInput {
  targetUrl: string;
  title: string;
  h1: string;
  notes: string;
  bodyExcerpt: string;
  buckets: {
    top3: unknown;
    pos4_10: unknown;
    pos11_20: unknown;
    pos21plus: unknown;
  };
  inbound: unknown[];
  outbound: unknown[];
  competitors: unknown;
  /** Operator-entered target keywords for this page (from page_target_keywords). */
  targetKeywords?: string[];
}

export async function generateBrief(input: BriefInput): Promise<string> {
  const user = `You are writing an SEO optimization brief for Wellows, an AI visibility SaaS. Apply Koray Tugberk Gubur's semantic SEO framework.

Voice: conversational casual, plain vocabulary, confident not hedgy. No emojis, no hype words (seamless, unlock, leverage, game-changer), no GPT openers.

Wellows central entity: AI visibility. Four moats:
1. Explicit + implicit citation tracking
2. Outreach layer for citation acquisition
3. Content optimization tied to citation impact
4. 485K-citation research dataset

TARGET PAGE:
URL: ${input.targetUrl}
Title: ${input.title}
H1: ${input.h1}
Operator notes: ${input.notes}

CURRENT BODY EXCERPT:
${input.bodyExcerpt.slice(0, 8000)}

GSC PERFORMANCE (last 90 days, grouped by position):
Top 3: ${JSON.stringify(input.buckets.top3)}
Positions 4-10: ${JSON.stringify(input.buckets.pos4_10)}
Positions 11-20: ${JSON.stringify(input.buckets.pos11_20)}
Positions 21+: ${JSON.stringify(input.buckets.pos21plus)}

INTERNAL LINKS:
Inbound (${input.inbound.length}): ${JSON.stringify(input.inbound.slice(0, 10))}
Outbound (${input.outbound.length}): ${JSON.stringify(input.outbound.slice(0, 10))}

SERP COMPETITION (top 5 per ranking query):
${JSON.stringify(input.competitors)}

Produce a markdown brief with these sections:

# Optimization Brief: ${input.targetUrl}

## Diagnosis
2-3 sentences on what is currently happening with this page.

## Primary Target Query (canonical)
The one query this page should own. Justify briefly.

## Koray Contextual Structure (proposed H2/H3 hierarchy)
List H2 and H3 headings. For each: contextual vector (entity-attribute pair it covers) and 1-line on content.

## Entity & Attribute Coverage Gaps
What AI-visibility entities/attributes competitors cover that this page does not. Be specific.

## Internal Link Actions
- Pages that should link TO this page (with anchor text matching H1)
- Pages this page should link FROM (Outer->Core direction if applicable)

## EEAT Additions
Wellows-specific trust signals: Khadija Zaman byline (SEO/AEO/GEO Manager at Wellows), 485K-citation dataset reference where it fits, customer testimonials.

## 7-Day Action List
Numbered list of concrete edits to make this week.`;

  const msg = await anthropic.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return "";
  return block.text;
}

export interface QueryInsightInput {
  query: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  previousTotals?: { clicks: number; impressions: number; ctr: number; position: number } | null;
  topPages: { url: string; clicks: number; impressions: number; ctr: number; position: number }[];
  recentLosers: { url: string; prevPos: number | null; currPos: number | null; impressionsChangePct: number | null; severity: string }[];
}

export interface QueryInsightResult {
  diagnosis: string;
  strategy: string[];
  aeoGeo: string[];
  sevenDayActions: string[];
}

export async function generateQueryInsight(input: QueryInsightInput): Promise<QueryInsightResult | null> {
  const system = `You are a senior SEO/AEO/GEO consultant for Wellows (an AI-visibility SaaS tracking brand citations in ChatGPT, Gemini, Perplexity, AI Overviews, and AI Mode). You analyse Google Search Console performance for a single query and write decisive, plain-spoken strategic guidance.

Voice rules: short sentences, no hype words (seamless, unlock, leverage, robust, supercharge, game-changer), no emojis, no GPT openers. Be specific — reference the actual numbers and URLs you were given.`;

  const user = `Query: "${input.query}"

Last 28 days totals:
- Clicks: ${input.totals.clicks}
- Impressions: ${input.totals.impressions}
- CTR: ${(input.totals.ctr * 100).toFixed(2)}%
- Avg position: ${input.totals.position.toFixed(1)}

${input.previousTotals ? `Previous 28 days:
- Clicks: ${input.previousTotals.clicks}
- Impressions: ${input.previousTotals.impressions}
- CTR: ${(input.previousTotals.ctr * 100).toFixed(2)}%
- Avg position: ${input.previousTotals.position.toFixed(1)}
` : ""}
Top pages ranking for this query (clicks / impressions / CTR / pos):
${input.topPages.slice(0, 10).map((p) => `- ${p.url} — ${p.clicks} / ${p.impressions} / ${(p.ctr * 100).toFixed(1)}% / ${p.position.toFixed(1)}`).join("\n") || "- (no pages found)"}

${input.recentLosers.length ? `Recent weekly losers on this query:
${input.recentLosers.slice(0, 5).map((l) => `- ${l.url} — pos ${l.prevPos ?? "?"} → ${l.currPos ?? "?"}, impressions change ${l.impressionsChangePct?.toFixed(1) ?? "?"}%, severity ${l.severity}`).join("\n")}
` : ""}
Return STRICT JSON only (no preamble, no markdown fences):
{
  "diagnosis": "2-3 sentences: where Wellows stands on this query right now, what the numbers say, and which page is doing the work",
  "strategy": ["3-5 traditional SEO actions — content depth, internal linking, anchor alignment, cannibalization fixes, etc., each a single concrete sentence"],
  "aeo_geo": ["3-5 AI-search-specific actions — entity coverage, FAQ schema, citation-worthy stats/quotes, list/table formatting for AI Overviews, ChatGPT/Perplexity citation hooks"],
  "seven_day_actions": ["3-5 things to ship this week, each starting with a verb and naming the specific URL when relevant"]
}`;

  try {
    const OpenAI = (await import("openai")).default;
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) return null;
    const openai = new OpenAI({ apiKey });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let text = "";
    try {
      const completion = await openai.chat.completions.create(
        {
          model: "gpt-4o-mini",
          max_tokens: 1400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        { signal: controller.signal },
      );
      text = completion.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as {
      diagnosis?: string;
      strategy?: string[];
      aeo_geo?: string[];
      seven_day_actions?: string[];
    };
    return {
      diagnosis: parsed.diagnosis ?? "",
      strategy: Array.isArray(parsed.strategy) ? parsed.strategy.filter((s) => typeof s === "string") : [],
      aeoGeo: Array.isArray(parsed.aeo_geo) ? parsed.aeo_geo.filter((s) => typeof s === "string") : [],
      sevenDayActions: Array.isArray(parsed.seven_day_actions) ? parsed.seven_day_actions.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return null;
  }
}
