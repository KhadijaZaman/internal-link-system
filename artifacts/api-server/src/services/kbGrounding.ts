import { db, kbChunksTable } from "@workspace/db";
import { embedText } from "../integrations/openaiEmbed";
import { cosineSim } from "../lib/semanticScorer";
import { logger } from "../lib/logger";

const TOP_K = 5;
const MAX_CHARS = 6000;

/**
 * Retrieve the most relevant operator knowledge-base passages for a brief.
 *
 * Embeds the supplied query text (primary query + title + h1), scores every
 * stored chunk by cosine similarity in app code (no pgvector operators exist),
 * and returns the top-k passages capped at ~6000 chars for injection into the
 * brief prompt.
 *
 * Fail-soft by design: an empty KB, a missing OPENAI_API_KEY, or any retrieval
 * error returns "" so brief generation continues ungrounded rather than
 * breaking.
 */
export async function retrieveKbGrounding(queryText: string): Promise<string> {
  const q = queryText.trim();
  if (q.length === 0) return "";
  try {
    const rows = await db
      .select({
        content: kbChunksTable.content,
        embedding: kbChunksTable.embedding,
      })
      .from(kbChunksTable);
    if (rows.length === 0) return "";

    const queryEmb = await embedText(q);
    const scored = rows
      .map((r) => ({ content: r.content, score: cosineSim(queryEmb, r.embedding) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    if (scored.length === 0) return "";

    const picked: string[] = [];
    let total = 0;
    for (const s of scored) {
      const remaining = MAX_CHARS - total;
      if (remaining <= 0) break;
      const piece = s.content.length > remaining ? s.content.slice(0, remaining) : s.content;
      picked.push(piece);
      total += piece.length;
    }
    if (picked.length === 0) return "";

    return picked.map((p, i) => `[Passage ${i + 1}]\n${p}`).join("\n\n");
  } catch (e) {
    logger.warn({ err: e }, "KB grounding retrieval failed; continuing without grounding");
    return "";
  }
}
