import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  queryGscDimension,
  aggregateTotals,
  listSitemaps,
  withCache,
  gscSiteUrl,
} from "../integrations/gsc";
import { fetchCrux } from "../integrations/crux";

const router: IRouter = Router();

const CHAT_MODEL = "gpt-4o-mini";

function getOpenAI(): OpenAI {
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for GSC chat");
  // timeout caps each attempt so a stuck upstream surfaces as an error the
  // client can show, instead of an SSE stream that hangs on "thinking" forever.
  return new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 1 });
}

const BRAND_TERMS = (process.env["GSC_BRAND_TERMS"] ?? "wellows")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

function isBrandedQuery(q: string): boolean {
  const lower = q.toLowerCase();
  return BRAND_TERMS.some((t) => lower.includes(t));
}

const SYSTEM = `You are a senior SEO analyst embedded in Wellows' GSC dashboard. Wellows is an AI visibility SaaS.
You read the user's question and the GSC slice provided, then answer plainly and tactically.

Voice rules:
- Conversational casual, plain vocabulary, confident not hedgy.
- No emojis, no GPT openers ("In today's...", "Let's dive in").
- Banned hype words: seamless, unlock, leverage, robust, cutting-edge, game-changer, supercharge.
- Short sentences. No em-dash decoration.

Always cite numbers from the provided slice. If the slice is empty, say so.`;

const DEFAULT_PROMPT = `Give me a tight read on this date range. Cover:
1. Headline movement (clicks, impressions, position) vs the previous period
2. Top winners (queries or pages climbing)
3. Top losers worth defending
4. Branded vs unbranded split — what does it suggest about demand
5. Indexing or Core Web Vitals issues worth flagging
6. One concrete action for this week`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ContextOpts {
  startDate: string;
  endDate: string;
  url?: string | null;
}

function previousRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
  };
}

function pct(curr: number, prev: number): number {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return ((curr - prev) / prev) * 100;
}

function trim<T extends { impressions: number; clicks: number; ctr: number; position: number; key: string }>(
  rows: T[],
  n: number,
) {
  return rows
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, n)
    .map((r) => ({
      key: r.key,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Number(r.ctr.toFixed(4)),
      position: Number(r.position.toFixed(2)),
    }));
}

async function buildContext(opts: ContextOpts, siteId: number): Promise<string> {
  const { startDate, endDate, url } = opts;
  const prev = previousRange(startDate, endDate);
  const property = gscSiteUrl();
  let cruxTarget: { origin?: string; url?: string };
  if (url) {
    cruxTarget = { url };
  } else if (property.startsWith("sc-domain:")) {
    cruxTarget = { origin: `https://${property.slice("sc-domain:".length)}` };
  } else {
    try {
      cruxTarget = { origin: new URL(property).origin };
    } catch {
      cruxTarget = {};
    }
  }

  const [queries, pages, dates, prevDates, sitemapsResult, cruxResult] = await Promise.all([
    queryGscDimension({ startDate, endDate, dimension: "query", pageFilter: url ?? undefined, rowLimit: 50 }),
    url ? Promise.resolve([]) : queryGscDimension({ startDate, endDate, dimension: "page", rowLimit: 30 }),
    queryGscDimension({ startDate, endDate, dimension: "date", pageFilter: url ?? undefined, rowLimit: 5000 }),
    queryGscDimension({ startDate: prev.startDate, endDate: prev.endDate, dimension: "date", pageFilter: url ?? undefined, rowLimit: 5000 }),
    withCache(`s${siteId}|ctx|sitemaps`, 30 * 60 * 1000, () => listSitemaps().catch(() => [])),
    withCache(`s${siteId}|ctx|cwv|${url ?? cruxTarget.origin ?? "?"}`, 60 * 60 * 1000, () => fetchCrux(cruxTarget)),
  ]);

  const totals = aggregateTotals(dates);
  const prevTotals = aggregateTotals(prevDates);

  const sitemapSummary = sitemapsResult.map((s) => ({
    path: s.path ?? "",
    errors: s.errors ? Number(s.errors) : 0,
    warnings: s.warnings ? Number(s.warnings) : 0,
    lastDownloaded: s.lastDownloaded ?? null,
    submittedTotal: (s.contents ?? []).reduce((sum, c) => sum + (c.submitted ? Number(c.submitted) : 0), 0),
    indexedTotal: (s.contents ?? []).reduce((sum, c) => sum + (c.indexed ? Number(c.indexed) : 0), 0),
  }));

  // Branded vs unbranded split computed from the top-50 query sample. This is a
  // sample, not the whole long tail — flag it as such in the JSON so Claude
  // doesn't overclaim.
  const brandedRows = queries.filter((q) => isBrandedQuery(q.key));
  const unbrandedRows = queries.filter((q) => !isBrandedQuery(q.key));
  const sumRows = (rows: typeof queries) => {
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? Number((clicks / impressions).toFixed(4)) : 0,
    };
  };

  const sitemapTotals = sitemapSummary.reduce(
    (acc, s) => {
      acc.submitted += s.submittedTotal;
      acc.indexed += s.indexedTotal;
      acc.errors += s.errors;
      return acc;
    },
    { submitted: 0, indexed: 0, errors: 0 },
  );
  const indexingSummary = {
    sitemaps: sitemapSummary,
    totalSubmitted: sitemapTotals.submitted,
    totalIndexed: sitemapTotals.indexed,
    totalSitemapErrors: sitemapTotals.errors,
    indexCoverageRatio:
      sitemapTotals.submitted > 0
        ? Number((sitemapTotals.indexed / sitemapTotals.submitted).toFixed(3))
        : null,
    notIndexedFromSitemaps: Math.max(0, sitemapTotals.submitted - sitemapTotals.indexed),
  };

  const cwvSummary = cruxResult.formFactors.map((ff) => ({
    formFactor: ff.formFactor,
    metrics: ff.metrics.map((m) => ({ metric: m.metric, p75: m.p75, band: m.band })),
  }));

  return JSON.stringify(
    {
      range: { startDate, endDate, url: url ?? null },
      previousRange: prev,
      totals: {
        clicks: totals.clicks,
        impressions: totals.impressions,
        ctr: Number(totals.ctr.toFixed(4)),
        position: Number(totals.position.toFixed(2)),
      },
      previousTotals: {
        clicks: prevTotals.clicks,
        impressions: prevTotals.impressions,
        ctr: Number(prevTotals.ctr.toFixed(4)),
        position: Number(prevTotals.position.toFixed(2)),
      },
      deltaPct: {
        clicks: Number(pct(totals.clicks, prevTotals.clicks).toFixed(2)),
        impressions: Number(pct(totals.impressions, prevTotals.impressions).toFixed(2)),
        ctr: Number(pct(totals.ctr, prevTotals.ctr).toFixed(2)),
        position: Number(pct(totals.position, prevTotals.position).toFixed(2)),
      },
      topQueries: trim(queries, 20),
      topPages: trim(pages, 20),
      brandedVsUnbranded: {
        note: "Computed from the top-50 query sample for this slice; long-tail not included.",
        brandTerms: BRAND_TERMS,
        branded: sumRows(brandedRows),
        unbranded: sumRows(unbrandedRows),
        topBrandedQueries: trim(brandedRows, 5),
        topUnbrandedQueries: trim(unbrandedRows, 5),
      },
      dailyPoints: dates.length,
      indexing: indexingSummary,
      coreWebVitals: cwvSummary.length > 0 ? cwvSummary : { notice: cruxResult.notice },
    },
    null,
    2,
  );
}

function buildPromptMessages(messages: ChatMessage[], includeDefault: boolean, contextJson: string): ChatMessage[] | null {
  // includeDefault prepends the canned analysis prompt as the first user turn.
  // When messages is empty, fall back to the default prompt unconditionally so
  // callers don't have to set both flags.
  const prompt: ChatMessage[] = [];
  if (includeDefault || messages.length === 0) {
    prompt.push({ role: "user", content: DEFAULT_PROMPT });
  }
  prompt.push(...messages);
  const first = prompt[0];
  if (!first) return null;
  return [
    { role: first.role, content: `GSC SLICE (JSON):\n${contextJson}\n\nQUESTION:\n${first.content}` },
    ...prompt.slice(1),
  ];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MESSAGES = 20;
const MAX_CONTENT = 4000;

function parseChatBody(req: { body: unknown }): {
  startDate: string;
  endDate: string;
  url: string | null;
  messages: ChatMessage[];
  includeDefault: boolean;
} | { error: string } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const startDate = typeof body["startDate"] === "string" ? body["startDate"] : "";
  const endDate = typeof body["endDate"] === "string" ? body["endDate"] : "";
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { error: "startDate and endDate must be YYYY-MM-DD" };
  }
  if (startDate > endDate) {
    return { error: "startDate must be <= endDate" };
  }

  const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
  if (rawMessages.length > MAX_MESSAGES) {
    return { error: `messages exceeds max of ${MAX_MESSAGES}` };
  }
  const messages: ChatMessage[] = [];
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") return { error: "each message must be an object" };
    const mo = m as Record<string, unknown>;
    if (mo["role"] !== "user" && mo["role"] !== "assistant") {
      return { error: "message.role must be 'user' or 'assistant'" };
    }
    if (typeof mo["content"] !== "string" || mo["content"].length === 0) {
      return { error: "message.content must be a non-empty string" };
    }
    if (mo["content"].length > MAX_CONTENT) {
      return { error: `message.content exceeds ${MAX_CONTENT} chars` };
    }
    messages.push({ role: mo["role"], content: mo["content"] });
  }

  const includeDefault = !!body["includeDefault"];
  if (messages.length === 0 && !includeDefault) {
    return { error: "messages or includeDefault required" };
  }

  let url: string | null = null;
  if (typeof body["url"] === "string" && body["url"].length > 0) {
    if (body["url"].length > 2048 || !/^https?:\/\//i.test(body["url"])) {
      return { error: "url must be a valid http(s):// URL" };
    }
    url = body["url"];
  }
  return { startDate, endDate, url, messages, includeDefault };
}

router.post("/gsc/chat", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = parseChatBody(req);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const contextJson = await buildContext(parsed, site.id);
    const withCtx = buildPromptMessages(parsed.messages, parsed.includeDefault, contextJson);
    if (!withCtx) {
      res.status(400).json({ error: "no messages" });
      return;
    }
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_tokens: 1400,
      messages: [
        { role: "system", content: SYSTEM },
        ...withCtx,
      ],
    });
    const reply = completion.choices[0]?.message?.content ?? "";
    res.json({
      reply,
      contextSummary: `Analyzed ${parsed.startDate} → ${parsed.endDate}${parsed.url ? ` for ${parsed.url}` : ""}`,
    });
  } catch (err) {
    req.log.error({ err }, "GSC chat failed");
    res.status(502).json({ error: "OpenAI request failed" });
  }
});

router.post("/gsc/chat/stream", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = parseChatBody(req);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  // Some upstream proxies (Replit's included) buffer chunked responses. Send
  // a 16 KB SSE comment up front so the proxy crosses its buffer threshold
  // and starts forwarding subsequent writes immediately.
  res.write(`: ${" ".repeat(16384)}\n\n`);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Detect client disconnect via res 'close', NOT req 'close'. Node emits
  // req 'close' as soon as the request body is fully consumed (which for a
  // JSON POST is before we even call the model), so keying off req would
  // mark the stream dead immediately and the response would never finish.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  // Start keep-alives immediately so the connection stays warm while we
  // build the GSC context and wait for the model's first token, not just
  // during delta streaming.
  const keepalive = setInterval(() => {
    if (closed) return;
    res.write(": keep-alive\n\n");
  }, 15_000);

  try {
    const contextJson = await buildContext(parsed, site.id);
    const withCtx = buildPromptMessages(parsed.messages, parsed.includeDefault, contextJson);
    if (!withCtx) {
      send("error", { error: "no messages" });
      res.end();
      return;
    }
    send("meta", {
      contextSummary: `Analyzed ${parsed.startDate} → ${parsed.endDate}${parsed.url ? ` for ${parsed.url}` : ""}`,
    });

    const openai = getOpenAI();
    const stream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_tokens: 1400,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM },
        ...withCtx,
      ],
    });

    for await (const chunk of stream) {
      if (closed) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) send("delta", { text: delta });
    }

    if (!closed) {
      send("done", { ok: true });
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "GSC chat stream failed");
    if (!closed) {
      send("error", { error: "OpenAI streaming failed" });
      res.end();
    }
  } finally {
    clearInterval(keepalive);
  }
});

export default router;
