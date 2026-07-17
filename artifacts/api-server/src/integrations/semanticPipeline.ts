/**
 * SemanticsX-style research pipeline (Phase 1).
 *
 * Implements the 6 research tools from the Content Suite doc:
 *   - extractOutlineFromHtml       (Outline Creator, deterministic)
 *   - extractNgrams                (N-Grams Extractor, deterministic)
 *   - generateEntities             (Entities Generator, LLM)
 *   - extractEntitiesFromText      (Entities Extractor, LLM)
 *   - generateNlpKeywords          (NLP Extractor, LLM)
 *   - generateSkipGrams            (Auto-Suggest dominant words, LLM)
 *   - generateGrammar              (Grammar Generator, LLM)
 *
 * All LLM calls use gpt-4o-mini for cost. JSON-mode responses where possible.
 * Fail-soft: every function catches OpenAI errors and returns a defensible
 * fallback (empty array / empty object) so a single bad call doesn't sink
 * the whole brief pipeline.
 */

import OpenAI from "openai";
import * as cheerio from "cheerio";
import { logger } from "../lib/logger";

export const SEMANTIC_MODEL = "gpt-4o-mini";

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","for","to","in","on","at","by","with","as","is","are","was","were","be","been","being","this","that","these","those","it","its","they","them","their","there","here","then","than","so","such","not","no","do","does","did","done","have","has","had","having","will","would","can","could","should","shall","may","might","must","i","you","we","he","she","him","her","our","your","my","mine","ours","yours","theirs","about","into","from","up","down","over","under","out","off","very","more","most","less","least","also","just","only","some","any","all","each","every","because","while","when","where","what","which","who","whom","whose","how","why","yes","ok","like","via","per",
]);

function getClient(): OpenAI {
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for the semantic pipeline.");
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) > 127) {
      throw new Error(
        `OPENAI_API_KEY contains a non-ASCII character at position ${i}. Re-paste from platform.openai.com.`,
      );
    }
  }
  return new OpenAI({ apiKey: key });
}

// ─── Outline Creator (deterministic) ─────────────────────────────────────────

export interface OutlineNode {
  level: 1 | 2 | 3 | 4;
  text: string;
}

export function extractOutlineFromHtml(html: string): OutlineNode[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, [aria-hidden=true]").remove();
  const root = $("main, article, [role=main]").first();
  const scope = root.length > 0 ? root : $("body");
  const nodes: OutlineNode[] = [];
  scope.find("h1, h2, h3, h4").each((_, el) => {
    const tag = String($(el).prop("tagName") ?? "").toLowerCase();
    if (!/^h[1-4]$/.test(tag)) return;
    const level = Number(tag.slice(1)) as 1 | 2 | 3 | 4;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length < 200) nodes.push({ level, text });
  });
  return nodes;
}

// ─── N-Grams Extractor (deterministic) ──────────────────────────────────────

export interface NgramHit {
  phrase: string;
  count: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function extractNgrams(text: string, n: 1 | 2 | 3 | 4, topK = 30): NgramHit[] {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(" ");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topK);
}

export function extractNgramSet(texts: string[]): Record<string, NgramHit[]> {
  const joined = texts.join("\n\n");
  return {
    "1gram": extractNgrams(joined, 1, 30),
    "2gram": extractNgrams(joined, 2, 30),
    "3gram": extractNgrams(joined, 3, 20),
    "4gram": extractNgrams(joined, 4, 15),
  };
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

async function callJson<T>(
  systemPrompt: string,
  userPrompt: string,
  fallback: T,
  label: string,
  maxTokens = 800,
): Promise<T> {
  try {
    const client = getClient();
    const res = await client.chat.completions.create({
      model: SEMANTIC_MODEL,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    return JSON.parse(text) as T;
  } catch (err) {
    logger.warn({ err, step: label }, "Semantic pipeline step failed; using fallback");
    return fallback;
  }
}

// ─── Entities Generator ──────────────────────────────────────────────────────

export async function generateEntities(keyword: string): Promise<string[]> {
  const result = await callJson<{ entities?: string[] }>(
    "You are a named-entity researcher for semantic SEO. Return strict JSON.",
    `Generate up to 30 semantically relevant NAMED ENTITIES for the topic "${keyword}". Include people, organizations, products, tools, frameworks, concepts, and technologies that top-ranking pages on this topic should cover. Each entity must be a proper noun or canonical concept name (not a generic phrase). Return JSON: {"entities": ["Entity One", "Entity Two", ...]}`,
    { entities: [] },
    "generateEntities",
    600,
  );
  return Array.isArray(result.entities)
    ? result.entities.filter((s): s is string => typeof s === "string").slice(0, 30)
    : [];
}

// ─── Entities Extractor (from competitor text) ──────────────────────────────

export async function extractEntitiesFromText(text: string): Promise<string[]> {
  if (!text.trim()) return [];
  const result = await callJson<{ entities?: string[] }>(
    "You are extracting named entities from competitor content for semantic SEO gap analysis. Return strict JSON.",
    `Extract every distinct NAMED ENTITY (people, organizations, products, tools, frameworks, branded concepts) that appears in the text below. Deduplicate. Skip generic nouns. Return JSON: {"entities": ["Entity One", ...]} (max 40).\n\nTEXT:\n${text.slice(0, 18000)}`,
    { entities: [] },
    "extractEntitiesFromText",
    700,
  );
  return Array.isArray(result.entities)
    ? result.entities.filter((s): s is string => typeof s === "string").slice(0, 40)
    : [];
}

// ─── NLP Keywords (LSI terms) ───────────────────────────────────────────────

export async function generateNlpKeywords(keyword: string): Promise<string[]> {
  const result = await callJson<{ keywords?: string[] }>(
    "You are generating Latent Semantic Indexing (LSI) keywords for semantic SEO. Return strict JSON.",
    `Generate 20 NLP / LSI keywords for the topic "${keyword}". These should be semantically related phrases (2-4 words) that frequently co-occur in top-ranking content on this topic. They are NOT synonyms — they are conceptually adjacent terms. Return JSON: {"keywords": ["phrase one", ...]}`,
    { keywords: [] },
    "generateNlpKeywords",
    500,
  );
  return Array.isArray(result.keywords)
    ? result.keywords.filter((s): s is string => typeof s === "string").slice(0, 20)
    : [];
}

// ─── Skip-grams (dominant word pairs) ───────────────────────────────────────

export async function generateSkipGrams(keyword: string): Promise<string[]> {
  const result = await callJson<{ pairs?: string[] }>(
    "You are generating skip-gram dominant word pairs for semantic SEO. Return strict JSON.",
    `Generate 25 skip-gram dominant 2-word pairs for "${keyword}". These are word pairs that frequently co-occur in proximity (within a 5-word window) in top-ranking content on this topic. Each is two words. Return JSON: {"pairs": ["search intent", "content optimization", ...]}`,
    { pairs: [] },
    "generateSkipGrams",
    400,
  );
  return Array.isArray(result.pairs)
    ? result.pairs.filter((s): s is string => typeof s === "string").slice(0, 25)
    : [];
}

// ─── Grammar Generator (semantic ontology) ──────────────────────────────────

export interface GrammarOntology {
  properNouns: string[];
  commonNouns: string[];
  synonyms: string[];
  antonyms: string[];
  hyponyms: string[];
  hypernyms: string[];
  meronyms: string[];
  holonyms: string[];
}

export async function generateGrammar(keyword: string): Promise<GrammarOntology> {
  const fallback: GrammarOntology = {
    properNouns: [], commonNouns: [], synonyms: [], antonyms: [],
    hyponyms: [], hypernyms: [], meronyms: [], holonyms: [],
  };
  const result = await callJson<Partial<GrammarOntology>>(
    "You are a linguist generating semantic word relationships (lexical ontology) for SEO. Return strict JSON only.",
    `For the topic "${keyword}", produce a semantic ontology following these categories. Limit each to 5 items.
- properNouns: branded proper nouns associated with the topic (e.g. SurferSEO, Ahrefs)
- commonNouns: domain-specific common nouns (e.g. algorithm, optimization)
- synonyms: alternative phrasings for the topic itself
- antonyms: opposing concepts (e.g. manual SEO vs AI SEO)
- hyponyms: more specific sub-types (e.g. AI-powered keyword research)
- hypernyms: parent / broader concepts (e.g. Digital Marketing)
- meronyms: components that make up the topic (e.g. natural language processing)
- holonyms: larger systems the topic is part of (e.g. Search Engine Marketing)

Return JSON with exactly these 8 keys, each an array of strings.`,
    fallback,
    "generateGrammar",
    700,
  );
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 5) : [];
  return {
    properNouns: arr(result.properNouns),
    commonNouns: arr(result.commonNouns),
    synonyms: arr(result.synonyms),
    antonyms: arr(result.antonyms),
    hyponyms: arr(result.hyponyms),
    hypernyms: arr(result.hypernyms),
    meronyms: arr(result.meronyms),
    holonyms: arr(result.holonyms),
  };
}
