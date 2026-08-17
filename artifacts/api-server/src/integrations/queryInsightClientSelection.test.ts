import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Focused test: generateQueryInsight picks the correct OpenAI client config
 * based on the available environment variables.
 *
 * - Proxy credentials present → uses proxy baseURL
 * - Only direct key present → uses api.openai.com (no custom baseURL)
 * - Neither present → returns null without making any API call
 */

const PROXY_KEY = "proxy-key-abc";
const PROXY_URL = "https://proxy.example.com/v1";
const DIRECT_KEY = "sk-direct-key-xyz";

const MINIMAL_INPUT = {
  query: "test query",
  totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  previousTotals: null,
  topPages: [],
  recentLosers: [],
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  delete process.env["OPENAI_API_KEY"];
});

async function importWithMock() {
  let capturedConfig: { apiKey?: string; baseURL?: string } | null = null;
  let constructorCalled = false;

  vi.doMock("openai", () => {
    class MockOpenAI {
      constructor(config: { apiKey?: string; baseURL?: string; timeout?: number; maxRetries?: number }) {
        capturedConfig = { apiKey: config.apiKey, baseURL: config.baseURL };
        constructorCalled = true;
      }
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    diagnosis: "test diag",
                    strategy: ["s1"],
                    aeo_geo: ["a1"],
                    seven_day_actions: ["act1"],
                  }),
                },
              },
            ],
          }),
        },
      };
    }
    return { default: MockOpenAI };
  });

  const { generateQueryInsight } = await import("./claude");
  return { generateQueryInsight, getConfig: () => capturedConfig, wasConstructed: () => constructorCalled };
}

describe("generateQueryInsight – OpenAI client selection", () => {
  it("uses the proxy baseURL when proxy credentials are set (even with a direct key)", async () => {
    vi.resetModules();
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = PROXY_KEY;
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = PROXY_URL;
    process.env["OPENAI_API_KEY"] = DIRECT_KEY;

    const { generateQueryInsight, getConfig } = await importWithMock();
    await generateQueryInsight(MINIMAL_INPUT);

    expect(getConfig()?.apiKey).toBe(PROXY_KEY);
    expect(getConfig()?.baseURL).toBe(PROXY_URL);
  });

  it("falls back to the direct key when proxy credentials are absent", async () => {
    vi.resetModules();
    process.env["OPENAI_API_KEY"] = DIRECT_KEY;

    const { generateQueryInsight, getConfig } = await importWithMock();
    await generateQueryInsight(MINIMAL_INPUT);

    expect(getConfig()?.apiKey).toBe(DIRECT_KEY);
    expect(getConfig()?.baseURL).toBeUndefined();
  });

  it("returns null without constructing a client when neither credential is set", async () => {
    vi.resetModules();

    const { generateQueryInsight, getConfig, wasConstructed } = await importWithMock();
    const result = await generateQueryInsight(MINIMAL_INPUT);

    expect(result).toBeNull();
    expect(wasConstructed()).toBe(false);
    expect(getConfig()).toBeNull();
  });
});
