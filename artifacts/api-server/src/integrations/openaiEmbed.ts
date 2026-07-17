import OpenAI from "openai";
import { logger } from "../lib/logger";

function getClient(): OpenAI {
  // Prefer a direct OpenAI API key — the Replit OpenAI integration proxy
  // does NOT support the embeddings endpoint, so embeddings must go to
  // api.openai.com directly with the user's own key.
  const directKey = process.env["OPENAI_API_KEY"]?.trim();
  if (directKey) {
    // Detect non-ASCII chars (e.g. smart-dash from a copy-paste) early so the
    // failure is a clear message instead of an undici ByteString error.
    for (let i = 0; i < directKey.length; i++) {
      const code = directKey.charCodeAt(i);
      if (code > 127) {
        throw new Error(
          `OPENAI_API_KEY contains a non-ASCII character at position ${i} ` +
            `(code ${code}). This usually means the key was pasted from a doc ` +
            `that auto-converted a hyphen into a smart dash. Please re-paste ` +
            `the key directly from https://platform.openai.com/api-keys.`,
        );
      }
    }
    return new OpenAI({ apiKey: directKey });
  }
  // Fail closed. The Replit OpenAI integration proxy does NOT support the
  // embeddings endpoint (returns 400 INVALID_ENDPOINT). Silently falling
  // back to it would let every embed call fail and leave the semantic
  // pipeline producing zero suggestions with only WARN logs.
  throw new Error(
    "OPENAI_API_KEY is not set. Embeddings require a direct OpenAI API key — the Replit OpenAI integration proxy does not support the embeddings endpoint.",
  );
}

const MODEL = "text-embedding-3-small";

export async function embedText(text: string): Promise<number[]> {
  const client = getClient();
  const trimmed = text.slice(0, 30000);
  const res = await client.embeddings.create({ model: MODEL, input: trimmed });
  const v = res.data[0]?.embedding;
  if (!v) throw new Error("No embedding returned");
  return v;
}

export async function embedBatch(
  inputs: { id: string | number; text: string }[],
  concurrency = 4,
): Promise<Map<string | number, number[]>> {
  const out = new Map<string | number, number[]>();
  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = i++;
      if (idx >= inputs.length) return;
      const item = inputs[idx]!;
      try {
        out.set(item.id, await embedText(item.text));
      } catch (e) {
        logger.warn({ id: item.id, err: e }, "Embed failed");
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}
