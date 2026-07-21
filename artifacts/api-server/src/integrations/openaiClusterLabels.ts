import OpenAI from "openai";
import { logger } from "../lib/logger";

/**
 * AI topic labels for keyword clusters.
 *
 * One gpt-4o-mini call per batch of clusters returns a concise, human-readable
 * label per cluster (e.g. "Startup & Business Ideas" instead of a raw member
 * keyword). Fail-soft by design: any error, timeout, or malformed response
 * leaves the caller's fallback label (the TF-IDF representative keyword) in
 * place — labeling must never fail a clustering run.
 */

export const CLUSTER_LABEL_MODEL = "gpt-4o-mini";
const BATCH_SIZE = 40;
const TIMEOUT_MS = 60_000;
const MAX_KEYWORDS_PER_CLUSTER = 10;
const MAX_LABEL_LENGTH = 80;

export interface ClusterLabelInput {
  /** Label used when AI labeling is unavailable or fails. */
  fallback: string;
  /** Member keywords, most important first. */
  keywords: string[];
}

const SYSTEM_PROMPT = [
  "You name keyword clusters for an SEO dashboard.",
  "For each cluster you receive its member search keywords.",
  "Return a concise, specific topic label (2-6 words, Title Case) that",
  "describes the shared search intent of the whole cluster.",
  "Never use quotation marks, colons, or trailing punctuation in labels.",
  "Do not just copy one keyword verbatim unless the cluster really is that narrow.",
  'Respond with JSON only: {"labels": [{"id": <number>, "label": <string>}, ...]}',
  "with exactly one entry per cluster id you were given.",
].join(" ");

function sanitizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/["\u201c\u201d\u00ab\u00bb]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Returns one label per input cluster (same order). Entries fall back to
 * `input.fallback` whenever the model call fails or returns an unusable label.
 */
export async function generateClusterLabels(
  clusters: ClusterLabelInput[],
): Promise<string[]> {
  const labels = clusters.map((c) => c.fallback);
  if (clusters.length === 0) return labels;

  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) {
    logger.warn("OPENAI_API_KEY not set; keeping keyword-based cluster topics");
    return labels;
  }
  const client = new OpenAI({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 1 });

  for (let start = 0; start < clusters.length; start += BATCH_SIZE) {
    const batch = clusters.slice(start, start + BATCH_SIZE);
    const payload = batch.map((c, i) => ({
      id: i,
      keywords: c.keywords.slice(0, MAX_KEYWORDS_PER_CLUSTER),
      totalKeywords: c.keywords.length,
    }));
    try {
      const res = await client.chat.completions.create({
        model: CLUSTER_LABEL_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ clusters: payload }) },
        ],
      });
      const text = res.choices[0]?.message?.content ?? "";
      const parsed: unknown = JSON.parse(text);
      const list =
        parsed && typeof parsed === "object" && Array.isArray((parsed as { labels?: unknown }).labels)
          ? ((parsed as { labels: unknown[] }).labels)
          : [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== "number" || !Number.isInteger(id)) continue;
        if (id < 0 || id >= batch.length) continue;
        const label = sanitizeLabel((item as { label?: unknown }).label);
        if (label) labels[start + id] = label;
      }
    } catch (e) {
      logger.warn(
        { err: e, batchStart: start, batchSize: batch.length },
        "Cluster labeling call failed; keeping keyword-based topics for this batch",
      );
    }
  }
  return labels;
}
