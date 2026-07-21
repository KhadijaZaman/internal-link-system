import OpenAI from "openai";
import { logger } from "../lib/logger";

/**
 * Per-article topic/theme extraction for the Content Similarity Explorer.
 *
 * One gpt-4o-mini call per article returns its key topics and a one-sentence
 * main theme. Fail-soft by design: any error returns empty topics and a null
 * theme — the article still participates in cosine-similarity scoring, which
 * only depends on the embedding.
 */

const MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 60_000;
/** Body text budget per article (title is sent separately). */
export const ANALYSIS_INPUT_CHARS = 5000;
const MAX_TOPICS = 6;
const MAX_TOPIC_LENGTH = 90;
const MAX_THEME_LENGTH = 500;

export interface ArticleAnalysis {
  topics: string[];
  mainTheme: string | null;
}

const SYSTEM_PROMPT = [
  "You analyze one web article for a content-relationship explorer.",
  "Given the article title and body text, identify 3-6 key topics",
  "(short noun phrases, Title Case) and the main theme: one or two",
  "sentences summarizing the article's central argument or purpose.",
  'Respond with JSON only: {"topics": [<string>, ...], "mainTheme": <string>}.',
].join(" ");

export async function analyzeArticleContent(
  title: string | null,
  bodyText: string,
): Promise<ArticleAnalysis> {
  const empty: ArticleAnalysis = { topics: [], mainTheme: null };
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) {
    logger.warn("OPENAI_API_KEY not set; skipping article topic analysis");
    return empty;
  }
  const client = new OpenAI({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 1 });
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            title: title ?? "",
            body: bodyText.slice(0, ANALYSIS_INPUT_CHARS),
          }),
        },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return empty;
    const rawTopics = (parsed as { topics?: unknown }).topics;
    const topics = Array.isArray(rawTopics)
      ? rawTopics
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim().slice(0, MAX_TOPIC_LENGTH))
          .slice(0, MAX_TOPICS)
      : [];
    const rawTheme = (parsed as { mainTheme?: unknown }).mainTheme;
    const mainTheme =
      typeof rawTheme === "string" && rawTheme.trim().length > 0
        ? rawTheme.trim().slice(0, MAX_THEME_LENGTH)
        : null;
    return { topics, mainTheme };
  } catch (e) {
    logger.warn({ err: e, title }, "Article topic analysis failed; continuing without topics");
    return empty;
  }
}
