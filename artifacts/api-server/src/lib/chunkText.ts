export const CHUNK_TARGET = 1400;
export const CHUNK_MAX = 1600;
export const CHUNK_OVERLAP = 150;

/**
 * Split long-form text into overlapping chunks at paragraph boundaries. Each
 * chunk is ~1200-1500 chars; consecutive chunks share ~150 chars of overlap so
 * a concept that straddles a boundary is still retrievable. Paragraphs longer
 * than the max are hard-split.
 *
 * Pure and db-free so it can be unit-tested without a DATABASE_URL.
 */
export function chunkText(text: string): string[] {
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
