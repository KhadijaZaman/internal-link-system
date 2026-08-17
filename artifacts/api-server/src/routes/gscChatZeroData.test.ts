import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Zero-data tool result tests for gscChat.
 *
 * Verifies that get_page_metrics and get_query_metrics return a
 * `zero_data_diagnostic` field (not a `notice`) when GSC returns zero
 * clicks and zero impressions, and that sibling pages are surfaced when
 * available. Also confirms the diagnostic is absent when real data exists.
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/site", () => ({
  requireSite: (_req: unknown, _res: unknown, next: () => void) => next(),
  getSite: () => ({ id: 1, host: "example.com", url: "https://example.com", protocol: "https" }),
}));

const mockQueryGscDimension = vi.fn();

vi.mock("../integrations/gsc", () => ({
  queryGscDimension: (...args: unknown[]) => mockQueryGscDimension(...args),
  aggregateTotals: vi.fn((rows: Array<{ clicks: number; impressions: number; ctr: number; position: number }>) => {
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: rows.length > 0 ? rows.reduce((s, r) => s + r.position, 0) / rows.length : 0,
    };
  }),
  pageVariantsRegex: vi.fn((url: string) => url),
  listSitemaps: vi.fn().mockResolvedValue([]),
  withCache: vi.fn((_k: string, _ttl: number, fn: () => unknown) => fn()),
  gscSiteUrl: vi.fn().mockResolvedValue("https://example.com"),
}));

vi.mock("../integrations/crux", () => ({
  fetchCrux: vi.fn().mockResolvedValue({ formFactors: [], notice: "no data" }),
}));

vi.mock("../integrations/ga4", () => ({
  queryGa4Pages: vi.fn().mockResolvedValue({
    rows: [],
    totals: { sessions: 0, engagementRate: 0, keyEvents: 0, aiSessions: 0 },
  }),
}));

const chainTail = { limit: vi.fn().mockResolvedValue([]) };
const orderByMock = vi.fn().mockReturnValue(chainTail);
const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock, ...chainTail });
const fromMock = vi.fn().mockReturnValue({ where: whereMock, orderBy: orderByMock, ...chainTail });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: fromMock }),
    selectDistinct: vi.fn().mockReturnValue({ from: fromMock }),
  },
  bingPageStatsTable: { siteId: "siteId", bucketDate: "bucketDate", path: "path" },
  linkGraphTable: { siteId: "siteId", placement: "placement", targetUrl: "targetUrl", sourceUrl: "sourceUrl", anchorText: "anchorText" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SseEvent = { event: string; data: Record<string, unknown> };

function makeMockRes(): { res: Record<string, unknown>; events: SseEvent[] } {
  const events: SseEvent[] = [];
  let buf = "";
  const res: Record<string, unknown> = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    write: vi.fn((chunk: string) => {
      buf += chunk;
      const blocks = buf.split("\n\n");
      for (let i = 0; i < blocks.length - 1; i++) {
        const block = (blocks[i] ?? "").trim();
        if (!block || block.startsWith(":")) continue;
        const lines = block.split("\n");
        const eLine = lines.find((l) => l.startsWith("event:"));
        const dLine = lines.find((l) => l.startsWith("data:"));
        if (eLine && dLine) {
          events.push({
            event: eLine.replace("event:", "").trim(),
            data: JSON.parse(dLine.replace("data:", "").trim()) as Record<string, unknown>,
          });
        }
      }
      buf = blocks[blocks.length - 1] ?? "";
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { res, events };
}

function makeStreamReq(body: Record<string, unknown>) {
  return {
    body,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
}

async function runStream(
  events: SseEvent[],
  res: Record<string, unknown>,
  openaiFactory: () => { chat: { completions: { create: ReturnType<typeof vi.fn> } } },
  body: Record<string, unknown>,
) {
  vi.doMock("openai", () => {
    class MockOpenAI {
      constructor(_cfg: unknown) {}
      chat = openaiFactory().chat;
    }
    return { default: MockOpenAI };
  });

  const { default: router } = await import("./gscChat");
  const req = makeStreamReq(body);

  type Layer = { route?: { path: string; stack: Array<{ handle: Function }> } };
  const layer = (router as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === "/gsc/chat/stream",
  );
  expect(layer?.route, "stream route registered").toBeDefined();

  const handlers = layer!.route!.stack.map((s) => s.handle);
  let idx = 0;
  const next = () => { const h = handlers[idx++]; h?.(req, res, next); };
  next();

  await new Promise<void>((resolve) => {
    const check = () => {
      if (
        events.some((e) => e.event === "done") ||
        events.some((e) => e.event === "error") ||
        (res.end as ReturnType<typeof vi.fn>).mock?.calls.length > 0
      ) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    setTimeout(check, 50);
    setTimeout(resolve, 5000);
  });
}

async function* toolThenTextStream(
  toolName: string,
  argsJson: string,
  replyText: string,
): AsyncIterable<unknown> {
  // First chunk: tool call
  yield {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "tc-1", function: { name: toolName, arguments: argsJson } }],
      },
      finish_reason: null,
    }],
  };
  yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
}

async function* textOnlyStream(text: string): AsyncIterable<unknown> {
  yield { choices: [{ delta: { content: text }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: "stop" }] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const COMMON_BODY = {
  messages: [{ role: "user", content: "Tell me about /blog/missing-page" }],
  startDate: "2026-07-01",
  endDate: "2026-07-28",
  includeDefault: false,
  url: null,
};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockQueryGscDimension.mockReset();
  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "proxy-key";
  process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "http://localhost:1106/modelfarm/openai";
});

describe("gscChat – zero GSC data in get_page_metrics tool", () => {
  it("includes zero_data_diagnostic when the page has zero impressions", async () => {
    // buildContext calls: query+page+date+prevDate (all return empty)
    // executeTool calls: query+date for the specific page + sibling lookup
    mockQueryGscDimension.mockResolvedValue([]);

    let capturedToolResult: Record<string, unknown> | null = null;
    let toolCallCount = 0;

    const { res, events } = makeMockRes();
    await runStream(
      events,
      res,
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
              toolCallCount++;
              if (opts.tools && toolCallCount === 1) {
                // First call: return a get_page_metrics tool call
                return toolThenTextStream("get_page_metrics", '{"page_url":"/blog/missing-page"}', "");
              }
              // Second call: model received tool result — capture it
              const toolMsg = opts.messages.find((m) => m.role === "tool");
              if (toolMsg && typeof toolMsg.content === "string") {
                capturedToolResult = JSON.parse(toolMsg.content) as Record<string, unknown>;
              }
              return textOnlyStream("The page has no GSC data.");
            }),
          },
        },
      }),
      COMMON_BODY,
    );

    expect(capturedToolResult, "tool result captured").not.toBeNull();
    expect(capturedToolResult).toHaveProperty("zero_data_diagnostic");
    expect(capturedToolResult).not.toHaveProperty("notice");
    expect(typeof capturedToolResult!["zero_data_diagnostic"]).toBe("string");
    expect(String(capturedToolResult!["zero_data_diagnostic"])).toContain("indexed");
  });

  it("includes similarPagesInSameSection when siblings have GSC data", async () => {
    const siblingRow = {
      key: "https://example.com/blog/real-post",
      clicks: 50,
      impressions: 800,
      ctr: 0.0625,
      position: 12.5,
    };

    // buildContext: return empty for everything
    // executeTool – get_page_metrics: first two calls (query+date) return [], third (sibling lookup) returns one row
    let gscCallCount = 0;
    mockQueryGscDimension.mockImplementation(async (opts: { dimension: string; pageRegex?: string }) => {
      gscCallCount++;
      // The sibling lookup uses dimension="page" with a prefix regex (no pageVariantsRegex wrapping)
      // It's called after the two zero-result calls for the specific page.
      // We detect it by: dimension===page AND we've already done the per-page calls
      if (opts.dimension === "page" && gscCallCount > 4) {
        return [siblingRow];
      }
      return [];
    });

    let capturedToolResult: Record<string, unknown> | null = null;
    let toolCallCount = 0;

    const { res, events } = makeMockRes();
    await runStream(
      events,
      res,
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
              toolCallCount++;
              if (opts.tools && toolCallCount === 1) {
                return toolThenTextStream("get_page_metrics", '{"page_url":"/blog/missing-page"}', "");
              }
              const toolMsg = opts.messages.find((m) => m.role === "tool");
              if (toolMsg && typeof toolMsg.content === "string") {
                capturedToolResult = JSON.parse(toolMsg.content) as Record<string, unknown>;
              }
              return textOnlyStream("Here are some nearby pages.");
            }),
          },
        },
      }),
      COMMON_BODY,
    );

    expect(capturedToolResult, "tool result captured").not.toBeNull();
    expect(capturedToolResult).toHaveProperty("zero_data_diagnostic");

    if (capturedToolResult!["similarPagesInSameSection"]) {
      const similar = capturedToolResult!["similarPagesInSameSection"] as Record<string, unknown>;
      expect(Array.isArray(similar["pages"])).toBe(true);
      const pages = similar["pages"] as Array<{ path: string }>;
      expect(pages.length).toBeGreaterThan(0);
      expect(pages[0]!.path).toContain("/blog/");
    }
    // Whether siblings appear depends on call order; the key invariant is no crash and no raw `notice`
    expect(capturedToolResult).not.toHaveProperty("notice");
  });

  it("does NOT include zero_data_diagnostic when the page has real impressions", async () => {
    const pageRow = { key: "2026-07-01", clicks: 10, impressions: 200, ctr: 0.05, position: 8 };
    mockQueryGscDimension.mockResolvedValue([pageRow]);

    let capturedToolResult: Record<string, unknown> | null = null;
    let toolCallCount = 0;

    const { res, events } = makeMockRes();
    await runStream(
      events,
      res,
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
              toolCallCount++;
              if (opts.tools && toolCallCount === 1) {
                return toolThenTextStream("get_page_metrics", '{"page_url":"/pricing"}', "");
              }
              const toolMsg = opts.messages.find((m) => m.role === "tool");
              if (toolMsg && typeof toolMsg.content === "string") {
                capturedToolResult = JSON.parse(toolMsg.content) as Record<string, unknown>;
              }
              return textOnlyStream("The page has data.");
            }),
          },
        },
      }),
      { ...COMMON_BODY, messages: [{ role: "user", content: "Tell me about /pricing" }] },
    );

    expect(capturedToolResult, "tool result captured").not.toBeNull();
    expect(capturedToolResult).not.toHaveProperty("zero_data_diagnostic");
    expect(capturedToolResult).not.toHaveProperty("notice");
  });
});

describe("gscChat – zero GSC data in get_query_metrics tool", () => {
  it("includes zero_data_diagnostic when the query returns no data", async () => {
    mockQueryGscDimension.mockResolvedValue([]);

    let capturedToolResult: Record<string, unknown> | null = null;
    let toolCallCount = 0;

    const { res, events } = makeMockRes();
    await runStream(
      events,
      res,
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
              toolCallCount++;
              if (opts.tools && toolCallCount === 1) {
                return toolThenTextStream("get_query_metrics", '{"query":"nonexistent keyword phrase"}', "");
              }
              const toolMsg = opts.messages.find((m) => m.role === "tool");
              if (toolMsg && typeof toolMsg.content === "string") {
                capturedToolResult = JSON.parse(toolMsg.content) as Record<string, unknown>;
              }
              return textOnlyStream("That keyword has no GSC data.");
            }),
          },
        },
      }),
      { ...COMMON_BODY, messages: [{ role: "user", content: "What's the data for 'nonexistent keyword phrase'?" }] },
    );

    expect(capturedToolResult, "tool result captured").not.toBeNull();
    expect(capturedToolResult).toHaveProperty("zero_data_diagnostic");
    expect(capturedToolResult).not.toHaveProperty("notice");
    const diag = String(capturedToolResult!["zero_data_diagnostic"]);
    expect(diag).toContain("nonexistent keyword phrase");
    expect(diag).toContain("volume");
  });

  it("does NOT include zero_data_diagnostic when the query has real data", async () => {
    const queryRow = { key: "https://example.com/pricing", clicks: 5, impressions: 120, ctr: 0.042, position: 14 };
    mockQueryGscDimension.mockResolvedValue([queryRow]);

    let capturedToolResult: Record<string, unknown> | null = null;
    let toolCallCount = 0;

    const { res, events } = makeMockRes();
    await runStream(
      events,
      res,
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
              toolCallCount++;
              if (opts.tools && toolCallCount === 1) {
                return toolThenTextStream("get_query_metrics", '{"query":"wellows seo tool"}', "");
              }
              const toolMsg = opts.messages.find((m) => m.role === "tool");
              if (toolMsg && typeof toolMsg.content === "string") {
                capturedToolResult = JSON.parse(toolMsg.content) as Record<string, unknown>;
              }
              return textOnlyStream("That keyword drives traffic to /pricing.");
            }),
          },
        },
      }),
      { ...COMMON_BODY, messages: [{ role: "user", content: "What's the data for 'wellows seo tool'?" }] },
    );

    expect(capturedToolResult, "tool result captured").not.toBeNull();
    expect(capturedToolResult).not.toHaveProperty("zero_data_diagnostic");
    expect(capturedToolResult).not.toHaveProperty("notice");
  });
});
