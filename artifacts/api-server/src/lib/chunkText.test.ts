import { describe, it, expect } from "vitest";
import { chunkText, CHUNK_MAX, CHUNK_OVERLAP, CHUNK_TARGET } from "./chunkText";

describe("chunkText", () => {
  it("returns an empty array for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \t ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Just one short paragraph.");
    expect(chunks).toEqual(["Just one short paragraph."]);
  });

  it("keeps multiple small paragraphs together in one chunk", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Para one.");
    expect(chunks[0]).toContain("Para three.");
  });

  it("normalizes CRLF line endings before splitting paragraphs", () => {
    const chunks = chunkText("Para one.\r\n\r\nPara two.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Para one.\n\nPara two.");
  });

  it("splits at paragraph boundaries when the buffer would exceed the max", () => {
    const para = "x".repeat(900);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
    }
  });

  it("carries overlap between consecutive paragraph-built chunks", () => {
    const paraA = "a".repeat(900);
    const paraB = "b".repeat(900);
    const paraC = "c".repeat(900);
    const chunks = chunkText(`${paraA}\n\n${paraB}\n\n${paraC}`);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0]!;
    const second = chunks[1]!;
    const overlap = first.slice(first.length - CHUNK_OVERLAP);
    expect(second.startsWith(overlap.trim())).toBe(true);
  });

  it("hard-splits a single paragraph longer than the max", () => {
    const long = "y".repeat(CHUNK_MAX * 3);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET);
    }
    // Consecutive hard-split pieces share overlap content.
    const step = CHUNK_TARGET - CHUNK_OVERLAP;
    expect(chunks[1]).toBe(long.slice(step, step + CHUNK_TARGET));
  });

  it("does not emit a redundant tail that is just the overlap of the last chunk", () => {
    // Varied content so suffix comparisons are meaningful (a repeated single
    // character would make every shorter slice a suffix of every longer one).
    const long = Array.from({ length: CHUNK_MAX + 10 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join("");
    const chunks = chunkText(long);
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2];
    if (prev) {
      expect(prev.endsWith(last)).toBe(false);
    }
  });

  it("preserves all non-overlap content (no text lost)", () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} ${"w".repeat(400)}`);
    const text = paras.join("\n\n");
    const joined = chunkText(text).join("\n");
    for (const p of paras) {
      expect(joined).toContain(`Paragraph number ${p.split(" ")[2]}`);
    }
  });
});
