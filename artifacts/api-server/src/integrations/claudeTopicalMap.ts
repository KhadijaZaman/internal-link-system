import { z } from "zod/v4";
import { anthropic, BRIEF_MODEL } from "./claude";
import { logger } from "../lib/logger";

/**
 * Two-phase Topical Authority Map generation per the Koray-framework SOP.
 *
 * Phase A (skeleton): from the operator's source-context charter plus a
 * site-demand digest (keyword clusters + existing sections), Claude proposes
 * 3-6 pillars split into CORE (main attributes, compare/use/buy predicates)
 * and OUTER (connected query networks, know predicate) sections.
 *
 * Phase B (expansion, one call per pillar, fail-soft): each pillar is
 * expanded into core topics → supporting topics → subtopics, plus contextual
 * bridges referencing other nodes by suggested slug. A pillar whose expansion
 * fails validation twice is kept as a bare pillar node rather than failing
 * the whole run.
 *
 * All model output is Zod-validated; each phase gets ONE retry that feeds the
 * validation error back to the model.
 */

export interface TopicalMapCharter {
  sourceContext: string;
  centralEntity: string;
  entitySynonyms: string[];
  centralSearchIntent: string;
  bordersWill: string[];
  bordersWillNot: string[];
}

export interface SiteDemandDigest {
  /** Keyword clusters from the latest complete cluster run (may be empty). */
  clusters: Array<{ topic: string; keywordCount: number; totalImpressions: number }>;
  /** Existing published sections and a sample of page titles. */
  sections: Array<{ section: string; pageCount: number }>;
  sampleTitles: string[];
}

const NodeMetaSchema = z.object({
  title: z.string().min(2).max(200),
  canonical_query: z.string().min(2).max(200),
  attribute_owned: z.string().min(2).max(200),
  intent: z.enum(["informational", "commercial", "transactional", "navigational"]),
  predicate: z.string().min(2).max(80),
  funnel_stage: z.enum(["tofu", "mofu", "bofu", "retention"]),
  page_type: z.string().min(2).max(60),
  suggested_slug: z
    .string()
    .min(2)
    .max(200)
    .regex(/^\/[a-z0-9\-/]+$/, "slug must be a lowercase path like /seed/node"),
  suggested_title: z.string().min(2).max(200),
  information_gain: z.string().max(400).nullish(),
  border_note: z.string().max(400).nullish(),
  priority: z.enum(["high", "medium", "low"]),
});

const PillarSchema = NodeMetaSchema.extend({
  section: z.enum(["core", "outer"]),
});

const SkeletonSchema = z.object({
  pillars: z.array(PillarSchema).min(2).max(6),
});

const SubtopicSchema = NodeMetaSchema;
const SupportingSchema = NodeMetaSchema.extend({
  subtopics: z.array(SubtopicSchema).max(4).default([]),
});
const CoreTopicSchema = NodeMetaSchema.extend({
  supporting: z.array(SupportingSchema).max(5).default([]),
});
const BridgeSchema = z.object({
  source_slug: z.string().min(2).max(200),
  target_slug: z.string().min(2).max(200),
  bridge_concept: z.string().min(2).max(300),
});
const ExpansionSchema = z.object({
  core_topics: z.array(CoreTopicSchema).min(1).max(8),
  bridges: z.array(BridgeSchema).max(10).default([]),
});

export type TopicalNodeMeta = z.infer<typeof NodeMetaSchema>;
export type TopicalPillar = z.infer<typeof PillarSchema>;
export type TopicalSkeleton = z.infer<typeof SkeletonSchema>;
export type TopicalExpansion = z.infer<typeof ExpansionSchema>;

const SYSTEM = `You are a semantic SEO strategist applying Koray Tugberk Gubur's Topical Authority Map framework. You design content maps, you do not write content.

Non-negotiable framework rules:
- Every node owns exactly ONE entity-attribute pair (its macro context) and exactly ONE canonical query. No "10 tips" nodes without an owned attribute.
- CORE section = main attributes of the central entity tied to the central search intent (monetization side); predicates bias to compare/use/buy; funnel mofu/bofu.
- OUTER section = connected query networks that build historical data; predicate almost entirely "know"; funnel tofu/retention. Never omit the outer section.
- URL slugs mirror hierarchy: root → seed → node, 1-2 words per segment, lowercase, hyphens, no stop words unless meaningful (e.g. /budgeting/zero-based/irregular-income).
- Deliberately repeat the central entity's key vocabulary across core-section titles.
- Respect the topical borders: WILL items are in scope, WILL NOT items are out of scope. When a node sits near a border, add a border_note ("covers X, defers Y to <sibling>").
- Each node states its information_gain: what it must add that the SERP lacks.

Output rules: return STRICT JSON only — no markdown fences, no preamble, no trailing commentary.`;

function charterBlock(charter: TopicalMapCharter): string {
  return `SOURCE CONTEXT (who we are + monetization bridge):
${charter.sourceContext}

CENTRAL ENTITY: ${charter.centralEntity}${
    charter.entitySynonyms.length > 0
      ? `\nENTITY SYNONYMS: ${charter.entitySynonyms.join(", ")}`
      : ""
  }
CENTRAL SEARCH INTENT: ${charter.centralSearchIntent}

TOPICAL BORDERS — WILL cover:
${charter.bordersWill.length > 0 ? charter.bordersWill.map((b) => `- ${b}`).join("\n") : "- (none given — infer sensible borders from the source context)"}

TOPICAL BORDERS — WILL NOT cover:
${charter.bordersWillNot.length > 0 ? charter.bordersWillNot.map((b) => `- ${b}`).join("\n") : "- (none given)"}`;
}

function demandBlock(demand: SiteDemandDigest): string {
  const clusters =
    demand.clusters.length > 0
      ? demand.clusters
          .slice(0, 40)
          .map((c) => `- ${c.topic} (${c.keywordCount} queries, ${c.totalImpressions} impressions)`)
          .join("\n")
      : "- (no keyword cluster data available)";
  const sections =
    demand.sections.length > 0
      ? demand.sections.map((s) => `- ${s.section}: ${s.pageCount} pages`).join("\n")
      : "- (no section data)";
  return `REAL SEARCH DEMAND — keyword clusters this site already surfaces for (from Search Console):
${clusters}

EXISTING SITE SECTIONS:
${sections}${
    demand.sampleTitles.length > 0
      ? `\n\nSAMPLE OF EXISTING PAGE TITLES (for vocabulary + overlap awareness):\n${demand.sampleTitles
          .slice(0, 60)
          .map((t) => `- ${t}`)
          .join("\n")}`
      : ""
  }`;
}

const NODE_JSON_FIELDS = `"title": "short node name",
  "canonical_query": "the ONE query this node owns",
  "attribute_owned": "entity-attribute pair, e.g. 'AI visibility — measurement'",
  "intent": "informational|commercial|transactional|navigational",
  "predicate": "know|learn|compare|use|buy|fix|go (comma-join if several)",
  "funnel_stage": "tofu|mofu|bofu|retention",
  "page_type": "guide|how_to|comparison|listicle|definition|landing|tool|case_study|glossary",
  "suggested_slug": "/seed/node lowercase path mirroring hierarchy",
  "suggested_title": "title tag (repeat core vocabulary in core section)",
  "information_gain": "what this page adds that the SERP lacks (or null)",
  "border_note": "one-line border rule when near a border (or null)",
  "priority": "high|medium|low"`;

async function callModel(user: string, maxTokens: number): Promise<string> {
  const msg = await anthropic.messages.create({
    model: BRIEF_MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("model returned no text");
  return block.text;
}

function extractJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in model response");
  return JSON.parse(m[0]) as unknown;
}

/**
 * Call the model, validate with `schema`; on failure retry ONCE with the
 * validation error appended so the model can self-correct.
 */
async function validatedCall<T>(
  user: string,
  schema: z.ZodType<T>,
  maxTokens: number,
  label: string,
): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED with this validation error — fix it and return the corrected strict JSON only:\n${lastError.slice(0, 1500)}`;
    try {
      const raw = await callModel(prompt, maxTokens);
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return parsed.data;
      lastError = JSON.stringify(parsed.error.issues.slice(0, 5));
      logger.warn({ label, attempt, issues: lastError }, "Topical map LLM output failed validation");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn({ label, attempt, err: lastError }, "Topical map LLM call failed");
    }
  }
  throw new Error(`${label}: model output invalid after retry — ${lastError.slice(0, 300)}`);
}

/** Phase A: propose the pillar skeleton (2-6 pillars across core + outer). */
export async function generateSkeleton(
  charter: TopicalMapCharter,
  demand: SiteDemandDigest,
): Promise<TopicalSkeleton> {
  const user = `${charterBlock(charter)}

${demandBlock(demand)}

TASK — Phase A of the map: propose the PILLAR layer only.
- 2 to 6 pillars total.
- At least one pillar in section "core" AND at least one in section "outer" (outer builds historical data that bridges back to core).
- Ground pillar choices in the real search demand above when it exists; do not invent demand the data contradicts.
- Pillars must sit inside the WILL borders and stay clear of WILL NOT.

Return strict JSON:
{
  "pillars": [{
    "section": "core|outer",
  ${NODE_JSON_FIELDS}
  }]
}`;
  return validatedCall(user, SkeletonSchema, 3000, "phase_a_skeleton");
}

/** Phase B: expand ONE pillar into core topics → supporting → subtopics + bridges. */
export async function expandPillar(
  charter: TopicalMapCharter,
  demand: SiteDemandDigest,
  pillar: TopicalPillar,
  allPillars: TopicalPillar[],
): Promise<TopicalExpansion> {
  const siblings = allPillars
    .filter((p) => p.suggested_slug !== pillar.suggested_slug)
    .map((p) => `- [${p.section}] ${p.title} (slug ${p.suggested_slug}, owns "${p.canonical_query}")`)
    .join("\n");
  const user = `${charterBlock(charter)}

${demandBlock(demand)}

FULL PILLAR SKELETON (for border awareness and bridges):
${siblings || "- (no other pillars)"}

TASK — Phase B: expand THIS pillar into its topic tree.
PILLAR: [${pillar.section}] ${pillar.title}
- owns query: "${pillar.canonical_query}"
- owns attribute: ${pillar.attribute_owned}
- slug: ${pillar.suggested_slug}

Rules:
- 3 to 8 core topics (main attributes / facets of the pillar), each with up to 5 supporting topics, each supporting with up to 4 subtopics. Go deep only where demand or the source context justifies it.
- Every node: ONE canonical query, ONE attribute, slug nested under the pillar slug.
- Section "${pillar.section}" defaults: ${
    pillar.section === "core"
      ? "compare/use/buy predicates, mofu/bofu funnel"
      : '"know" predicate, tofu funnel'
  } — deviate only when the node genuinely differs.
- No overlap with the other pillars listed above; when a node borders one, add a border_note deferring to it.
- bridges: up to 10 contextual cross-links justified by a shared sub-concept. ${
    pillar.section === "outer"
      ? "This is an OUTER pillar — every top-level core topic here should bridge back to a core-section node (that transfer is the point of the outer section)."
      : "Bridge siblings only across a REAL shared sub-concept."
  } Use suggested_slug values (yours or other pillars') for source_slug/target_slug.

Return strict JSON:
{
  "core_topics": [{
  ${NODE_JSON_FIELDS},
    "supporting": [{
    ${NODE_JSON_FIELDS},
      "subtopics": [{
      ${NODE_JSON_FIELDS}
      }]
    }]
  }],
  "bridges": [{ "source_slug": "/...", "target_slug": "/...", "bridge_concept": "shared sub-concept" }]
}`;
  return validatedCall(user, ExpansionSchema, 16000, `phase_b_${pillar.suggested_slug}`);
}
