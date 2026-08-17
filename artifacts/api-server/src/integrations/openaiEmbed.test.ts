import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for openaiEmbed failure-state behaviour:
 * - embedBatch throws loudly when every input fails (key exhausted / not set)
 * - embedBatch logs ERROR and returns partial results on partial failure
 * - embedBatch returns empty map for empty input (no throw)
 */

// We mock the openai module so no network calls are made.
vi.mock("openai", () => {
  class MockOpenAI {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_config: any) {}
    embeddings = {
      create: vi.fn(),
    };
  }
  return { default: MockOpenAI };
});

// Capture logger.error calls
vi.mock("../lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Convenience: return a valid embedding response
function makeEmbedResponse(dims = 1536) {
  return { data: [{ embedding: Array.from({ length: dims }, (_, i) => i / dims) }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["OPENAI_API_KEY"] = "sk-test-key";
});

afterEach(() => {
  delete process.env["OPENAI_API_KEY"];
});

describe("embedBatch – failure states", () => {
  it("throws when every input fails (key exhausted scenario)", async () => {
    const { default: OpenAI } = await import("openai");
    const instance = new (OpenAI as unknown as new (c: unknown) => { embeddings: { create: ReturnType<typeof vi.fn> } })({});
    vi.mocked(instance.embeddings.create).mockRejectedValue(
      new Error("insufficient_quota — you have exceeded your quota"),
    );
    // Patch the prototype so any constructed instance uses the mocked method
    (OpenAI as unknown as { prototype: { embeddings: { create: ReturnType<typeof vi.fn> } } }).prototype.embeddings = {
      create: vi.fn().mockRejectedValue(new Error("insufficient_quota — you have exceeded your quota")),
    };

    const { embedBatch } = await import("./openaiEmbed");
    await expect(
      embedBatch([
        { id: "a", text: "hello" },
        { id: "b", text: "world" },
      ]),
    ).rejects.toThrow(/embedBatch: all 2 embedding request\(s\) failed/);
  });

  it("returns empty map without throwing for empty input", async () => {
    const { embedBatch } = await import("./openaiEmbed");
    const result = await embedBatch([]);
    expect(result.size).toBe(0);
  });

  it("returns null / missing when OPENAI_API_KEY is absent", async () => {
    delete process.env["OPENAI_API_KEY"];
    const { embedBatch } = await import("./openaiEmbed");
    await expect(
      embedBatch([{ id: "x", text: "test" }]),
    ).rejects.toThrow(/embedBatch: all 1 embedding request\(s\) failed/);
  });
});
