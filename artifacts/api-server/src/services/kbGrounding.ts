import { eq } from "drizzle-orm";
import { db, kbChunksTable, kbDocumentsTable, type GroundingPassage } from "@workspace/db";
import { embedText } from "../integrations/openaiEmbed";
import { cosineSim } from "../lib/semanticScorer";
import { logger } from "../lib/logger";

const TOP_K = 5;
const MAX_CHARS = 6000;
const EXCERPT_CHARS = 300;

export interface KbGroundingResult {
  /** Formatted passage block for prompt injection; "" when nothing retrieved. */
  text: string;
  /** Metadata about each passage actually injected (same order as `text`). */
  passages: GroundingPassage[];
}

const EMPTY: KbGroundingResult = { text: "", passages: [] };

/**
 * Retrieve the most relevant operator knowledge-base passages for a brief.
 *
 * Embeds the supplied query text (primary query + title + h1), scores every
 * stored chunk by cosine similarity in app code (no pgvector operators exist),
 * and returns the top-k passages capped at ~6000 chars for injection into the
 * brief prompt — plus per-passage metadata (document, score, excerpt) so the
 * UI can show exactly which sources grounded the brief.
 *
 * Fail-soft by design: an empty KB, a missing OPENAI_API_KEY, or any retrieval
 * error returns { text: "", passages: [] } so brief generation continues
 * ungrounded rather than breaking.
 */
export async function retrieveKbGrounding(queryText: string): Promise<KbGroundingResult> {
  const q = queryText.trim();
  if (q.length === 0) return EMPTY;
  try {
    const rows = await db
      .select({
        documentId: kbChunksTable.documentId,
        chunkIndex: kbChunksTable.chunkIndex,
        content: kbChunksTable.content,
        embedding: kbChunksTable.embedding,
        documentTitle: kbDocumentsTable.title,
      })
      .from(kbChunksTable)
      .innerJoin(kbDocumentsTable, eq(kbChunksTable.documentId, kbDocumentsTable.id));
    if (rows.length === 0) return EMPTY;

    const queryEmb = await embedText(q);
    const scored = rows
      .map((r) => ({ ...r, score: cosineSim(queryEmb, r.embedding) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    if (scored.length === 0) return EMPTY;

    const picked: string[] = [];
    const passages: GroundingPassage[] = [];
    let total = 0;
    for (const s of scored) {
      const remaining = MAX_CHARS - total;
      if (remaining <= 0) break;
      const piece = s.content.length > remaining ? s.content.slice(0, remaining) : s.content;
      picked.push(piece);
      total += piece.length;
      passages.push({
        documentId: s.documentId,
        documentTitle: s.documentTitle,
        chunkIndex: s.chunkIndex,
        score: Math.round(s.score * 1000) / 1000,
        excerpt:
          piece.length > EXCERPT_CHARS ? `${piece.slice(0, EXCERPT_CHARS).trimEnd()}…` : piece,
      });
    }
    if (picked.length === 0) return EMPTY;

    return {
      text: picked.map((p, i) => `[Passage ${i + 1}]\n${p}`).join("\n\n"),
      passages,
    };
  } catch (e) {
    logger.warn({ err: e }, "KB grounding retrieval failed; continuing without grounding");
    return EMPTY;
  }
}
