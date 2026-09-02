import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Streaming route tool-call cap tests.
 *
 * Two scenarios:
 * 1. Sequential cap: 5 tool calls across 5 completions (one per turn) → 6th
 *    completion has no tools, produces text delta + done.
 * 2. Parallel cap: 4 calls then 3 more in a single turn (total 7 if uncapped)
 *    → only first 5 execute; the 6th+7th get sentinel results; next completion
 *    has no tools and produces text.
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/site", () => ({
  requireSite: (_req: unknown, _res: unknown, next: () => void) => next(),
  getSite: () => ({ id: 1, host: "example.com", url: "https://example.com", protocol: "https" }),
}));

vi.mock("../integrations/gsc", () => ({
  queryGscDimension: vi.fn().mockResolvedValue([]),
  aggregateTotals: vi.fn().mockReturnValue({ clicks: 0, impressions: 0, ctr: 0, position: 0 }),
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
  linkGraphTable: { targetSiteId: "targetSiteId", targetPath: "targetPath", sourcePath: "sourcePath" },
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

function makeMockReq() {
  return {
    body: {
      messages: [{ role: "user", content: "What are metrics for /pricing?" }],
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      includeDefault: false,
      url: null,
    },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
}

async function callStreamHandler(
  openaiFactory: () => { chat: { completions: { create: ReturnType<typeof vi.fn> } } },
  events: SseEvent[],
  res: Record<string, unknown>,
) {
  // Dynamically import after mocks are set up
  vi.doMock("openai", () => {
    class MockOpenAI {
      constructor(_cfg: unknown) {}
      chat = openaiFactory().chat;
    }
    return { default: MockOpenAI };
  });

  const { default: router } = await import("./gscChat");
  const req = makeMockReq();

  type Layer = { route?: { path: string; stack: Array<{ handle: Function }> } };
  const layer = (router as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === "/gsc/chat/stream",
  );
  expect(layer?.route, "stream route registered").toBeDefined();

  const handlers = layer!.route!.stack.map((s) => s.handle);
  let idx = 0;
  const next = () => { const h = handlers[idx++]; h?.(req, res, next); };
  next();

  // Wait for async work — poll until done or timeout
  await new Promise<void>((resolve) => {
    const check = () => {
      if (events.some((e) => e.event === "done") ||
          events.some((e) => e.event === "error") ||
          (res.end as ReturnType<typeof vi.fn>).mock?.calls.length > 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    setTimeout(check, 50);
    setTimeout(resolve, 5000);
  });
}

// ─── Stream generators ────────────────────────────────────────────────────────

async function* singleToolStream(toolId: string): AsyncIterable<unknown> {
  yield {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: toolId,
          function: { name: "get_page_metrics", arguments: '{"page_url":"/pricing"}' },
        }],
      },
      finish_reason: null,
    }],
  };
  yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
}

/** Three parallel tool calls in one streaming response */
async function* parallelToolStream(baseId: string): AsyncIterable<unknown> {
  for (let i = 0; i < 3; i++) {
    yield {
      choices: [{
        delta: {
          tool_calls: [{
            index: i, id: `${baseId}-${i}`,
            function: { name: "get_page_metrics", arguments: '{"page_url":"/pricing"}' },
          }],
        },
        finish_reason: null,
      }],
    };
  }
  yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
}

async function* textStream(text: string): AsyncIterable<unknown> {
  yield { choices: [{ delta: { content: text }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: "stop" }] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const MAX_TOOL_CALLS = 5;

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
});

describe("gscChat /gsc/chat/stream – tool-call cap", () => {
  it("sequential: makes a tools-disabled final completion after 5 tool calls and emits text delta + done", async () => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "proxy-key";
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "http://localhost:1106/modelfarm/openai";

    const toolCalls: boolean[] = [];
    let callCount = 0;

    const { res, events } = makeMockRes();
    await callStreamHandler(
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown }) => {
              const hasTools = !!opts.tools;
              toolCalls.push(hasTools);
              callCount++;
              if (hasTools && callCount <= MAX_TOOL_CALLS) {
                return singleToolStream(`call-${callCount}`);
              }
              return textStream("Final answer.");
            }),
          },
        },
      }),
      events,
      res,
    );

    // 5 tool-call completions + 1 final text completion
    expect(toolCalls.length, "total OpenAI calls").toBe(MAX_TOOL_CALLS + 1);
    expect(toolCalls.slice(0, MAX_TOOL_CALLS).every(Boolean), "first 5 include tools").toBe(true);
    expect(toolCalls[MAX_TOOL_CALLS], "6th call omits tools").toBe(false);

    const deltas = events.filter((e) => e.event === "delta");
    expect(deltas.length, "delta events received").toBeGreaterThan(0);
    expect(
      deltas.some((d) => String(d.data["text"]).includes("couldn't produce a fully grounded answer")),
      "uncited final text is replaced by a grounded refusal",
    ).toBe(true);
    expect(
      deltas.every((d) => !String(d.data["text"]).includes("Final answer.")),
      "rejected draft text never reaches the client",
    ).toBe(true);

    const done = events.find((e) => e.event === "done");
    expect(done, "done event received").toBeDefined();
    expect(done!.data["ok"], "done.ok is true").toBe(true);
  });

  it("parallel: enforces cap within a single turn (3 parallel calls on turn 2 when 4 already used)", async () => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "proxy-key";
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "http://localhost:1106/modelfarm/openai";

    const toolCalls: boolean[] = [];
    let callCount = 0;
    // Turns: 4 single-tool calls → 1 triple-tool call (only 1 should execute) → final text
    let executedToolCalls = 0;

    const { res, events } = makeMockRes();
    await callStreamHandler(
      () => ({
        chat: {
          completions: {
            create: vi.fn(async (opts: { tools?: unknown }) => {
              const hasTools = !!opts.tools;
              toolCalls.push(hasTools);
              callCount++;
              if (!hasTools) return textStream("Final answer with parallel cap.");
              if (callCount <= 4) return singleToolStream(`seq-${callCount}`);
              // Turn 5: return 3 parallel tool calls — only 1 should be executed
              return parallelToolStream(`par-${callCount}`);
            }),
          },
        },
      }),
      events,
      res,
    );

    // Count tool_use events emitted to the client (only for actually-executed calls)
    const toolCallEvents = events.filter((e) => e.event === "tool_use");
    executedToolCalls = toolCallEvents.length;

    // Exactly 5 total calls are executed (4 sequential + 1 from the parallel batch)
    expect(executedToolCalls, "executed tool calls capped at 5").toBe(MAX_TOOL_CALLS);

    // The last OpenAI completion must have tools omitted
    expect(toolCalls[toolCalls.length - 1], "final completion omits tools").toBe(false);

    // Final text reaches the client
    const deltas = events.filter((e) => e.event === "delta");
    expect(
      deltas.some((d) => String(d.data["text"]).includes("couldn't produce a fully grounded answer")),
      "uncited final text is replaced by a grounded refusal",
    ).toBe(true);

    const done = events.find((e) => e.event === "done");
    expect(done, "done event received").toBeDefined();
    expect(done!.data["ok"], "done.ok is true").toBe(true);
  });
});
