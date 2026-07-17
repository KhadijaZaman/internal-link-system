import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, kbDocumentsTable, kbChunksTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { AddKbDocumentBody } from "@workspace/api-zod";
import { embedBatch } from "../integrations/openaiEmbed";

const router: IRouter = Router();

const CHUNK_TARGET = 1400;
const CHUNK_MAX = 1600;
const CHUNK_OVERLAP = 150;

/**
 * Split long-form text into overlapping chunks at paragraph boundaries. Each
 * chunk is ~1200-1500 chars; consecutive chunks share ~150 chars of overlap so
 * a concept that straddles a boundary is still retrievable. Paragraphs longer
 * than the max are hard-split.
 */
function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  const paras = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = "";
  const flush = (): void => {
    const t = buf.trim();
    if (t.length === 0) return;
    chunks.push(t);
    buf = t.length > CHUNK_OVERLAP ? t.slice(t.length - CHUNK_OVERLAP) : "";
  };
  for (const para of paras) {
    if (para.length > CHUNK_MAX) {
      if (buf.trim().length > 0) flush();
      buf = "";
      let i = 0;
      while (i < para.length) {
        const piece = para.slice(i, i + CHUNK_TARGET).trim();
        if (piece.length > 0) chunks.push(piece);
        i += CHUNK_TARGET - CHUNK_OVERLAP;
      }
      continue;
    }
    if (buf.length + para.length + 2 > CHUNK_MAX && buf.trim().length > 0) {
      flush();
    }
    buf += buf.length > 0 ? `\n\n${para}` : para;
  }
  const tail = buf.trim();
  const last = chunks[chunks.length - 1];
  // Skip the leftover buffer when it is just the overlap suffix of the last
  // emitted chunk (no genuinely new content) — avoids storing/embedding a
  // redundant fragment.
  if (tail.length > 0 && !(last && last.endsWith(tail))) {
    chunks.push(tail);
  }
  return chunks;
}

router.get("/kb/documents", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      id: kbDocumentsTable.id,
      title: kbDocumentsTable.title,
      charCount: kbDocumentsTable.charCount,
      chunkCount: kbDocumentsTable.chunkCount,
      createdAt: kbDocumentsTable.createdAt,
    })
    .from(kbDocumentsTable)
    .orderBy(desc(kbDocumentsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      charCount: r.charCount,
      chunkCount: r.chunkCount,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  );
});

router.post("/kb/documents", requireAuth, async (req, res) => {
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

  // Embed every chunk once at upload. embedBatch fails soft per-chunk (logs a
  // warning and skips), so a missing OPENAI_API_KEY leaves chunks stored
  // without embeddings rather than failing the upload — they just won't be
  // retrievable until re-uploaded with a key present.
  const embMap = await embedBatch(chunks.map((c, i) => ({ id: i, text: c })));
  if (embMap.size === 0) {
    req.log.warn(
      { chunks: chunks.length },
      "KB upload: no chunks embedded (OPENAI_API_KEY missing or all embeds failed); document stored without grounding vectors",
    );
  }

  const inserted = await db
    .insert(kbDocumentsTable)
    .values({ title, charCount: content.length, chunkCount: chunks.length })
    .returning();
  const doc = inserted[0];
  if (!doc) {
    res.status(500).json({ error: "Failed to create document" });
    return;
  }

  await db.insert(kbChunksTable).values(
    chunks.map((chunkContent, i) => ({
      documentId: doc.id,
      chunkIndex: i,
      content: chunkContent,
      embedding: embMap.get(i),
    })),
  );

  req.log.info(
    { documentId: doc.id, chunks: chunks.length, embedded: embMap.size },
    "KB document uploaded",
  );
  res.status(201).json({
    id: doc.id,
    title: doc.title,
    charCount: doc.charCount,
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt?.toISOString() ?? null,
  });
});

router.delete("/kb/documents/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(kbDocumentsTable).where(eq(kbDocumentsTable.id, id));
  res.json({ ok: true });
});

export default router;
