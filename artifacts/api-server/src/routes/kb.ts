import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, kbDocumentsTable, kbChunksTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { AddKbDocumentBody } from "@workspace/api-zod";
import { chunkText } from "../lib/chunkText";
import { runJob } from "../jobs/runner";

const router: IRouter = Router();

interface DocRow {
  id: number;
  title: string;
  charCount: number;
  chunkCount: number;
  embedStatus: string;
  embeddedChunkCount: number;
  createdAt: Date | null;
}

function serialize(r: DocRow) {
  return {
    id: r.id,
    title: r.title,
    charCount: r.charCount,
    chunkCount: r.chunkCount,
    embedStatus: r.embedStatus,
    embeddedChunkCount: r.embeddedChunkCount,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

router.get("/kb/documents", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const rows = await db
    .select({
      id: kbDocumentsTable.id,
      title: kbDocumentsTable.title,
      charCount: kbDocumentsTable.charCount,
      chunkCount: kbDocumentsTable.chunkCount,
      embedStatus: kbDocumentsTable.embedStatus,
      // count(col) skips NULLs, so this is "chunks with an embedding".
      embeddedChunkCount: sql<number>`count(${kbChunksTable.embedding})::int`,
      createdAt: kbDocumentsTable.createdAt,
    })
    .from(kbDocumentsTable)
    .leftJoin(
      kbChunksTable,
      and(
        eq(kbChunksTable.documentId, kbDocumentsTable.id),
        eq(kbChunksTable.siteId, site.id),
      ),
    )
    .where(eq(kbDocumentsTable.siteId, site.id))
    .groupBy(kbDocumentsTable.id)
    .orderBy(desc(kbDocumentsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/kb/documents", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = AddKbDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "title (1-300) and content (1-500000) are required" });
    return;
  }
  const title = parsed.data.title.trim();
  const content = parsed.data.content;
  if (title.length === 0 || content.trim().length === 0) {
    res.status(400).json({ error: "title and content cannot be empty" });
    return;
  }

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    res.status(400).json({ error: "content produced no chunks" });
    return;
  }

  // Store the document + chunks immediately (no embeddings yet) and hand the
  // embedding work to the background `embed_kb_chunks` job, so large uploads
  // return fast instead of blocking the request on OpenAI calls.
  // Single transaction: an already-running embed job must never observe the
  // pending document without its chunks (it would otherwise see zero missing
  // chunks and could mis-derive the document's status).
  const doc = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(kbDocumentsTable)
      .values({
        siteId: site.id,
        title,
        charCount: content.length,
        chunkCount: chunks.length,
        embedStatus: "pending",
      })
      .returning();
    const d = inserted[0];
    if (!d) throw new Error("Failed to create document");
    await tx.insert(kbChunksTable).values(
      chunks.map((chunkContent, i) => ({
        siteId: site.id,
        documentId: d.id,
        chunkIndex: i,
        content: chunkContent,
      })),
    );
    return d;
  });

  // Fire-and-forget: the job drain-loops until no pending documents remain,
  // so "Already running" is fine — the running instance will pick this up.
  const startResult = await runJob("embed_kb_chunks");
  req.log.info(
    {
      documentId: doc.id,
      chunks: chunks.length,
      embedJobStarted: startResult.started,
    },
    "KB document uploaded; embedding queued",
  );

  res.status(201).json(
    serialize({
      id: doc.id,
      title: doc.title,
      charCount: doc.charCount,
      chunkCount: doc.chunkCount,
      embedStatus: doc.embedStatus,
      embeddedChunkCount: 0,
      createdAt: doc.createdAt,
    }),
  );
});

router.delete("/kb/documents/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(kbDocumentsTable)
    .where(
      and(
        eq(kbDocumentsTable.id, id),
        eq(kbDocumentsTable.siteId, site.id),
      ),
    );
  res.json({ ok: true });
});

export default router;
