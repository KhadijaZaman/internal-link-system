import OpenAI from "openai";
import { logger } from "../lib/logger";

const MODEL = "text-embedding-3-small";

/**
 * Try the Replit AI-integrations proxy first.  Some proxy instances do not
 * support the embeddings endpoint and return HTTP 400 / "INVALID_ENDPOINT" —
 * we detect that specific signal and fall back to the direct key so the
 * feature keeps working regardless of whether the proxy supports embeddings
 * today or gains support in the future.
 *
 * If neither path works (proxy 400 + no direct key, or direct key returns 429
 * insufficient_quota) the error is rethrown so the caller sees a clear failure.
 */
export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.slice(0, 30000);

  // ── Proxy attempt ────────────────────────────────────────────────────────
  const proxyKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]?.trim();
  const proxyUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]?.trim();
  if (proxyKey && proxyUrl) {
    try {
      const proxy = new OpenAI({ apiKey: proxyKey, baseURL: proxyUrl });
      const res = await proxy.embeddings.create({ model: MODEL, input: trimmed });
      const v = res.data[0]?.embedding;
      if (!v) throw new Error("Proxy returned no embedding vector");
      return v;
    } catch (err) {
      // A 400 from the proxy means "endpoint not routed here"; fall through
      // to the direct key.  Any other error (401, 429, network) is rethrown.
      const isUnsupported =
        (err instanceof OpenAI.APIError && err.status === 400) ||
        (err instanceof Error &&
          (err.message.includes("INVALID_ENDPOINT") ||
            err.message.includes("not supported")));
      if (!isUnsupported) throw err;
      logger.debug(
        { err },
        "openaiEmbed: proxy does not support embeddings endpoint; falling back to direct key",
      );
    }
  }

  // ── Direct key fallback ──────────────────────────────────────────────────
  const directKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!directKey) {
    throw new Error(
      "Embeddings are unavailable: the Replit AI-integrations proxy does not support " +
        "the embeddings endpoint, and OPENAI_API_KEY is not set. " +
        "Please add a funded OpenAI API key at https://platform.openai.com/api-keys.",
    );
  }

  // Detect non-ASCII chars (e.g. smart-dash from copy-paste) early.
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

  const direct = new OpenAI({ apiKey: directKey });
  const res = await direct.embeddings.create({ model: MODEL, input: trimmed });
  const v = res.data[0]?.embedding;
  if (!v) throw new Error("No embedding returned");
  return v;
}

export async function embedBatch(
  inputs: { id: string | number; text: string }[],
  concurrency = 4,
): Promise<Map<string | number, number[]>> {
  const out = new Map<string | number, number[]>();
  if (inputs.length === 0) return out;

  let i = 0;
  let failures = 0;
  let lastError: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      const idx = i++;
      if (idx >= inputs.length) return;
      const item = inputs[idx]!;
      try {
        out.set(item.id, await embedText(item.text));
      } catch (e) {
        failures++;
        lastError = e;
        logger.warn({ id: item.id, err: e }, "Embed failed");
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // If every input failed, the key is almost certainly exhausted or missing.
  // Throw so the calling job is marked failed rather than silently producing
  // zero embeddings and leaving documents unindexed.
  if (failures > 0 && out.size === 0) {
    const hint =
      lastError instanceof Error && lastError.message.includes("insufficient_quota")
        ? " The OPENAI_API_KEY is out of credits — top up the account or set a new key."
        : lastError instanceof Error && lastError.message.includes("OPENAI_API_KEY is not set")
          ? " No OPENAI_API_KEY is configured. The Replit AI-integrations proxy does not support the embeddings endpoint — a direct key is required."
          : "";
    throw new Error(
      `embedBatch: all ${failures} embedding request(s) failed.${hint} Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  if (failures > 0) {
    logger.error(
      { total: inputs.length, succeeded: out.size, failed: failures, lastError },
      "embedBatch: partial failure — some documents will not be indexed",
    );
  }

  return out;
}
