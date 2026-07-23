import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db, kbDocumentsTable, kbChunksTable } from "@workspace/db";
import { embedBatch } from "../integrations/openaiEmbed";
import { budgetForSite } from "../lib/jobBudget";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

/**
 * Background embedding for knowledge-base documents.
 *
 * Uploads store chunks with NULL embeddings and mark the document "pending";
 * this job drains them: it keeps re-selecting non-ready documents and embedding
 * their missing chunks until a pass finds nothing pending, so documents
 * uploaded *while* the job is running are picked up in the same run.
 *
 * Status is derived from actual chunk counts after each attempt:
 *   - "ready"   — every chunk has an embedding
 *   - "partial" — some chunks still missing after an attempt (embedBatch fails
 *                 soft per chunk, e.g. missing OPENAI_API_KEY). Partial docs
 *                 are retried once at the start of each run, but not re-looped
 *                 within a run, so a permanently failing chunk can't spin.
 */
export async function runEmbedKbChunks(site: SiteContext): Promise<void> {
  const budget = budgetForSite(site);
  let firstPass = true;
  let totalEmbedded = 0;
  let capped = false;
  drain: for (;;) {
    const statuses = firstPass ? ["pending", "partial"] : ["pending"];
    firstPass = false;
    const docs = await db
      .select({
        id: kbDocumentsTable.id,
        title: kbDocumentsTable.title,
        chunkCount: kbDocumentsTable.chunkCount,
      })
      .from(kbDocumentsTable)
      .where(
        and(
          eq(kbDocumentsTable.siteId, site.id),
          inArray(kbDocumentsTable.embedStatus, statuses),
        ),
      )
      .orderBy(kbDocumentsTable.id);
    if (docs.length === 0) break;

    for (const doc of docs) {
      const missing = await db
        .select({ id: kbChunksTable.id, content: kbChunksTable.content })
        .from(kbChunksTable)
        .where(
          and(
            eq(kbChunksTable.siteId, site.id),
            eq(kbChunksTable.documentId, doc.id),
            isNull(kbChunksTable.embedding),
          ),
        )
        .orderBy(kbChunksTable.chunkIndex);

      let embedded = 0;
      if (missing.length > 0) {
        // Spend cap: one embedding call per missing chunk. If the batch would
        // exceed the remaining LLM budget, stop the drain gracefully — the
        // 10-min sweep resumes the rest on the next run.
        if (!budget.take("llmCalls", missing.length)) {
          capped = true;
          logger.warn(
            {
              documentId: doc.id,
              title: doc.title,
              needed: missing.length,
              remaining: budget.remaining("llmCalls"),
            },
            "KB embed: LLM budget cap reached; stopping drain (sweep will resume)",
          );
          break drain;
        }
        const embMap = await embedBatch(missing.map((c) => ({ id: c.id, text: c.content })));
        for (const c of missing) {
          const emb = embMap.get(c.id);
          if (!emb) continue;
          await db.update(kbChunksTable).set({ embedding: emb }).where(eq(kbChunksTable.id, c.id));
          embedded++;
        }
      }
      totalEmbedded += embedded;

      // Derive status from the actual embedded-chunk count vs the document's
      // declared chunkCount — never from the `missing` snapshot, which could
      // be empty/stale if chunks were still being inserted when we looked.
      // A doc is "ready" only when every declared chunk has an embedding.
      const [counted] = await db
        .select({ embeddedNow: sql<number>`count(*)::int` })
        .from(kbChunksTable)
        .where(
          and(
            eq(kbChunksTable.siteId, site.id),
            eq(kbChunksTable.documentId, doc.id),
            isNotNull(kbChunksTable.embedding),
          ),
        );
      const embeddedNow = counted?.embeddedNow ?? 0;
      const status = doc.chunkCount > 0 && embeddedNow >= doc.chunkCount ? "ready" : "partial";
      await db
        .update(kbDocumentsTable)
        .set({ embedStatus: status })
        .where(eq(kbDocumentsTable.id, doc.id));
      logger.info(
        {
          documentId: doc.id,
          title: doc.title,
          missing: missing.length,
          embedded,
          embeddedNow,
          chunkCount: doc.chunkCount,
          status,
        },
        "KB embed: document processed",
      );
    }
  }
  logger.info({ totalEmbedded, capped }, "KB embed: drain complete");
  if (budget.anyExhausted()) {
    logger.warn({ budget: budget.summary() }, "KB embed: spend budget exhausted");
  }
}
