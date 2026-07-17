import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";

export interface ClassifyInput {
  url: string;
  title: string;
  h1: string | null;
  excerpt: string;
  bodyExcerpt: string;
  wordCount: number;
  focusKeyword: string | null;
}

export interface ClassifyResult {
  tier: 1 | 2 | 3 | 4;
  centralEntity: string;
  subEntity: string | null;
  parentRootUrl: string | null;
  canonicalQuery: string;
  anchorVariants: string[];
  topicalBordersMatch: boolean;
}

const SYSTEM = `You classify a Wellows page into a 4-tier semantic SEO hierarchy. Wellows is an AI visibility SaaS tracking brand citations across ChatGPT, Gemini, Perplexity, AI Overviews, AI Mode. Central entity: "AI visibility".

Tiers:
- Tier 1: Homepage or pillar root (e.g. /, /ai-visibility). Single root of a topical map.
- Tier 2: Sub-pillar / category root (e.g. /chatgpt-visibility, /perplexity-citations). Anchors a sub-entity.
- Tier 3: Cluster page covering a canonical query (most blog posts).
- Tier 4: Outer supporting / long-tail piece, news, comparison, FAQ.

Topical borders WILL cover: AI search visibility, generative engine optimization, citation tracking, LLM ranking, prompt-aware SEO, AEO, GEO.
Topical borders WILL NOT cover: classical SEO basics for Google blue links only, paid ads, social media management.

Return ONLY valid JSON, no prose.`;

export async function classifyPage(input: ClassifyInput): Promise<ClassifyResult | null> {
  const user = `URL: ${input.url}
Title: ${input.title}
H1: ${input.h1 ?? ""}
Focus keyword: ${input.focusKeyword ?? ""}
Word count: ${input.wordCount}
Excerpt: ${input.excerpt.slice(0, 400)}
Body excerpt: ${input.bodyExcerpt.slice(0, 1500)}

Return JSON:
{
  "tier": 1 | 2 | 3 | 4,
  "central_entity": "the unifying entity this page connects to",
  "sub_entity": "narrower sub-entity or null",
  "parent_root_url": "tier 1 or 2 url this page sits under, or null",
  "canonical_query": "the single query this page is built to own",
  "anchor_variants": ["3-5 lemmatized anchor text variations of the H1"],
  "topical_borders_match": true | false
}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const block = msg.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const m = block.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as {
      tier?: number;
      central_entity?: string;
      sub_entity?: string | null;
      parent_root_url?: string | null;
      canonical_query?: string;
      anchor_variants?: string[];
      topical_borders_match?: boolean;
    };
    if (!p.tier || p.tier < 1 || p.tier > 4) return null;
    return {
      tier: p.tier as 1 | 2 | 3 | 4,
      centralEntity: p.central_entity ?? "AI visibility",
      subEntity: p.sub_entity ?? null,
      parentRootUrl: p.parent_root_url ?? null,
      canonicalQuery: p.canonical_query ?? input.title,
      anchorVariants: Array.isArray(p.anchor_variants)
        ? p.anchor_variants.slice(0, 5).filter((s) => typeof s === "string")
        : [],
      topicalBordersMatch: p.topical_borders_match !== false,
    };
  } catch (e) {
    logger.warn({ url: input.url, err: e }, "Classify failed");
    return null;
  }
}

export function linkQuotaFromWordCount(words: number): { min: number; max: number } {
  // 2-4 links per 1000 words corridor
  const min = Math.max(1, Math.floor((words / 1000) * 2));
  const max = Math.max(min, Math.ceil((words / 1000) * 4));
  return { min, max };
}
