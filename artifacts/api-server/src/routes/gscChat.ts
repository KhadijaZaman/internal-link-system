import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  queryGscDimension,
  aggregateTotals,
  pageVariantsRegex,
  listSitemaps,
  withCache,
  gscSiteUrl,
} from "../integrations/gsc";
import { fetchCrux } from "../integrations/crux";
import { queryGa4Pages } from "../integrations/ga4";
import type { SiteContext } from "../lib/site";
import { db, bingPageStatsTable, linkGraphTable } from "@workspace/db";
import { and, eq, desc, inArray } from "drizzle-orm";

const router: IRouter = Router();

const CHAT_MODEL = "gpt-4o-mini";

function getOpenAI(): OpenAI {
  // Prefer the Replit AI-integrations proxy (billed via Replit, no separate
  // OpenAI credits needed); fall back to a direct key if the proxy env vars
  // are absent. The direct OPENAI_API_KEY ran out of credits 2026-07-30.
  const proxyKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]?.trim();
  const proxyUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]?.trim();
  // timeout caps each attempt so a stuck upstream surfaces as an error the
  // client can show, instead of an SSE stream that hangs on "thinking" forever.
  if (proxyKey && proxyUrl) {
    return new OpenAI({ apiKey: proxyKey, baseURL: proxyUrl, timeout: 60_000, maxRetries: 1 });
  }
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for GSC chat");
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
You read the user's question and the data slice provided (Google Search Console, GA4 organic-landing-page metrics, Bing Webmaster weekly stats, and — when a page is selected — its internal-link graph), then answer plainly and tactically.

Grounding rules (strict):
- Every number you state must come from the slice. Never estimate, extrapolate, or use outside knowledge about the site.
- When a source shows a notice instead of data, say it isn't connected rather than guessing.
- If the slice can't answer the question, say exactly what's missing (e.g. "pick that page in the URL filter and ask again").

When the user asks about a specific URL/page, structure the answer around:
1. GSC: clicks, impressions, CTR, average position, top queries for that page, trend vs previous period
2. GA4: organic sessions, engagement, key events (conversions), AI-assistant-referred sessions
3. Bing: latest-week clicks and impressions
4. Internal links: inbound/outbound in-content link counts and notable anchors
5. One overall read: what these sources together say is happening, and one action.

You have two tools available:
- get_page_metrics: fetch GSC data for any page on this site. Use it when the user asks about a page not in the initial context.
- get_query_metrics: fetch GSC data for any search query. Use it when the user asks about a keyword not visible in the initial context.

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

/** All reasonable URL spellings of one page (scheme/www/trailing-slash), for
 * matching link_graph target_url rows which store full crawled URLs. */
function urlVariants(url: string): string[] {
  const u = new URL(url);
  const hosts = u.host.startsWith("www.") ? [u.host, u.host.slice(4)] : [u.host, `www.${u.host}`];
  const paths = u.pathname.endsWith("/") && u.pathname !== "/"
    ? [u.pathname, u.pathname.slice(0, -1)]
    : [u.pathname, `${u.pathname}/`];
  const out: string[] = [];
  for (const scheme of ["https", "http"]) for (const h of hosts) for (const p of paths) out.push(`${scheme}://${h}${p}`);
  return out;
}

/** Internal links pointing AT the selected page, from the crawled link graph.
 * Sidebar/nav placements are excluded — same rule as the SEO activity counts. */
async function internalLinksSummary(siteId: number, url: string) {
  const variants = urlVariants(url);
  const rows = await db
    .select({
      sourceUrl: linkGraphTable.sourceUrl,
      anchorText: linkGraphTable.anchorText,
    })
    .from(linkGraphTable)
    .where(
      and(
        eq(linkGraphTable.siteId, siteId),
        eq(linkGraphTable.placement, "content"),
        inArray(linkGraphTable.targetUrl, variants),
      ),
    );
  const outbound = await db
    .select({ targetUrl: linkGraphTable.targetUrl })
    .from(linkGraphTable)
    .where(
      and(
        eq(linkGraphTable.siteId, siteId),
        eq(linkGraphTable.placement, "content"),
        inArray(linkGraphTable.sourceUrl, variants),
      ),
    );
  return {
    note: "In-content internal links from the latest crawl (nav/sidebar excluded).",
    inboundCount: rows.length,
    outboundCount: outbound.length,
    inboundLinks: rows.slice(0, 20).map((r) => ({
      fromPath: (() => { try { return new URL(r.sourceUrl).pathname; } catch { return r.sourceUrl; } })(),
      anchor: r.anchorText ?? null,
    })),
  };
}

/**
 * Bing weekly stats already synced by sync_bing_pages — no external call.
 * Returns the two most recent weekly buckets so the model can talk movement.
 */
async function bingSummary(siteId: number, url: string | null | undefined) {
  const buckets = await db
    .selectDistinct({ bucketDate: bingPageStatsTable.bucketDate })
    .from(bingPageStatsTable)
    .where(eq(bingPageStatsTable.siteId, siteId))
    .orderBy(desc(bingPageStatsTable.bucketDate))
    .limit(2);
  if (buckets.length === 0) return null;
  const dates = buckets.map((b) => b.bucketDate);
  const path = url ? new URL(url).pathname : null;
  const rows = await db
    .select()
    .from(bingPageStatsTable)
    .where(
      and(
        eq(bingPageStatsTable.siteId, siteId),
        inArray(bingPageStatsTable.bucketDate, dates),
        ...(path ? [eq(bingPageStatsTable.path, path)] : []),
      ),
    );
  const byBucket = (d: string) => rows.filter((r) => r.bucketDate === d);
  const total = (list: typeof rows) => ({
    clicks: list.reduce((s, r) => s + r.clicks, 0),
    impressions: list.reduce((s, r) => s + r.impressions, 0),
  });
  const latest = byBucket(dates[0]!);
  return {
    note: "Bing Webmaster weekly buckets (site-synced); latestWeek vs priorWeek shows movement.",
    latestWeek: { bucketDate: dates[0], ...total(latest) },
    priorWeek: dates[1] ? { bucketDate: dates[1], ...total(byBucket(dates[1]!)) } : null,
    topPages: latest
      .slice()
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 15)
      .map((r) => ({
        path: r.path,
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position != null ? Number(r.position.toFixed(1)) : null,
      })),
  };
}

async function ga4Summary(site: SiteContext, startDate: string, endDate: string, url: string | null | undefined) {
  const { rows, totals } = await queryGa4Pages({ startDate, endDate, channel: "organic", site });
  const path = url ? new URL(url).pathname : null;
  const scoped = path ? rows.filter((r) => r.path === path || r.path === `${path}/`) : rows;
  // When the chat is scoped to one page, totals must come from the scoped
  // rows — site-wide totals next to a page-filtered GSC slice mislead the model.
  const scopedTotals = path
    ? {
        sessions: scoped.reduce((s, r) => s + r.sessions, 0),
        engagementRate:
          scoped.reduce((s, r) => s + r.sessions, 0) > 0
            ? scoped.reduce((s, r) => s + r.engagedSessions, 0) /
              scoped.reduce((s, r) => s + r.sessions, 0)
            : 0,
        keyEvents: scoped.reduce((s, r) => s + r.keyEvents, 0),
        aiSessions: scoped.reduce((s, r) => s + r.aiSessions, 0),
      }
    : totals;
  const round = (r: (typeof rows)[number]) => ({
    path: r.path,
    sessions: r.sessions,
    engagementRate: Number(r.engagementRate.toFixed(3)),
    avgEngagementTimeSec: Number(r.avgEngagementTime.toFixed(0)),
    keyEvents: r.keyEvents,
    aiSessions: r.aiSessions,
  });
  return {
    note: "GA4 organic-channel landing pages; keyEvents = conversions; aiSessions = sessions referred by AI assistants.",
    totals: {
      scope: path ? "selected page only" : "site-wide organic",
      sessions: scopedTotals.sessions,
      engagementRate: Number(scopedTotals.engagementRate.toFixed(3)),
      keyEvents: scopedTotals.keyEvents,
      aiSessions: scopedTotals.aiSessions,
    },
    topPages: scoped.slice(0, 15).map(round),
  };
}

async function buildContext(opts: ContextOpts, site: SiteContext): Promise<string> {
  const siteId = site.id;
  const { startDate, endDate, url } = opts;
  const prev = previousRange(startDate, endDate);
  const property = await gscSiteUrl(siteId);
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

  const [queries, pages, dates, prevDates, sitemapsResult, cruxResult, ga4Result, bingResult, linksResult] = await Promise.all([
    queryGscDimension({ siteId, startDate, endDate, dimension: "query", pageRegex: url ? gscPageRegex(url) : undefined, rowLimit: 50 }),
    url ? Promise.resolve([]) : queryGscDimension({ siteId, startDate, endDate, dimension: "page", rowLimit: 30 }),
    queryGscDimension({ siteId, startDate, endDate, dimension: "date", pageRegex: url ? gscPageRegex(url) : undefined, rowLimit: 5000 }),
    queryGscDimension({ siteId, startDate: prev.startDate, endDate: prev.endDate, dimension: "date", pageRegex: url ? gscPageRegex(url) : undefined, rowLimit: 5000 }),
    withCache(`s${siteId}|ctx|sitemaps`, 30 * 60 * 1000, () => listSitemaps(siteId).catch(() => [])),
    withCache(`s${siteId}|ctx|cwv|${url ?? cruxTarget.origin ?? "?"}`, 60 * 60 * 1000, () => fetchCrux(cruxTarget)),
    // GA4/Bing grounding is best-effort: if the source isn't connected the
    // chat still answers from GSC alone, with an explicit notice.
    withCache(`s${siteId}|ctx|ga4|${startDate}|${endDate}|${url ?? ""}`, 30 * 60 * 1000, () =>
      ga4Summary(site, startDate, endDate, url).catch(() => null),
    ),
    bingSummary(siteId, url).catch(() => null),
    url ? internalLinksSummary(siteId, url).catch(() => null) : Promise.resolve(null),
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
      ga4: ga4Result ?? { notice: "GA4 not connected or unavailable for this site/range." },
      bing: bingResult ?? { notice: "Bing Webmaster data not synced for this site." },
      ...(url
        ? { internalLinks: linksResult ?? { notice: "No crawl data for this page yet." } }
        : {}),
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
    { role: first.role, content: `DATA SLICE (GSC + GA4 + Bing, JSON):\n${contextJson}\n\nQUESTION:\n${first.content}` },
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
    if (body["url"].length > 2048) return { error: "url too long" };
    let parsed: URL;
    try {
      parsed = new URL(body["url"]);
    } catch {
      return { error: "url must be a valid http(s):// URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "url must be a valid http(s):// URL" };
    }
    // Embedded credentials would flow into cache keys, CrUX requests, and
    // logs — reject rather than strip so the caller notices.
    if (parsed.username || parsed.password) {
      return { error: "url must not contain credentials" };
    }
    // Normalize: drop fragment/query so cache keys and downstream matching
    // are canonical (GSC page queries still match variants via regex).
    parsed.hash = "";
    parsed.search = "";
    url = parsed.href;
  }
  return { startDate, endDate, url, messages, includeDefault };
}

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** RE2 page regex matching all GSC spellings of one page: optional www,
 * optional trailing slash, plus #fragment variants (GSC splits those into
 * separate page rows — they must be summed, not missed). */
function gscPageRegex(url: string): string {
  const u = new URL(url);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const host = esc(stripWww(u.host));
  const path = esc(u.pathname.replace(/\/$/, ""));
  return `^https?://(www\\.)?${host}${path}/?(#.*)?$`;
}

/** The chat's page filter must belong to the selected site — otherwise an
 * authenticated user could burn shared CrUX quota on arbitrary hosts and get
 * mixed-source answers about pages that aren't theirs. */
function urlBelongsToSite(url: string, site: SiteContext): boolean {
  try {
    return stripWww(new URL(url).host) === stripWww(site.host);
  } catch {
    return false;
  }
}

const MAX_TOOL_CALLS = 5;

router.post("/gsc/chat", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = parseChatBody(req);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.url && !urlBelongsToSite(parsed.url, site)) {
    res.status(400).json({ error: "url must be a page on this site" });
    return;
  }

  try {
    const contextJson = await buildContext(parsed, site);
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
  if (parsed.url && !urlBelongsToSite(parsed.url, site)) {
    res.status(400).json({ error: "url must be a page on this site" });
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
    const contextJson = await buildContext(parsed, site);
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

    const toolOpts = { startDate: parsed.startDate, endDate: parsed.endDate, siteId: site.id, site };

    // Conversation message history for the tool-calling loop.
    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      ...withCtx,
    ];

    let toolCallsUsed = 0;
    let continueLoop = true;

    while (continueLoop && !closed) {
      continueLoop = false;
      // Accumulate streaming tool-call argument fragments keyed by tool index.
      const toolCallAccum: Record<number, { id: string; name: string; argsJson: string }> = {};
      let assistantText = "";
      let finishReason: string | null = null;

      const stream = await openai.chat.completions.create({
        model: CHAT_MODEL,
        max_tokens: 1400,
        stream: true,
        // Disable tools once the cap is reached to force a text reply.
        ...(toolCallsUsed < MAX_TOOL_CALLS ? { tools: TOOLS, tool_choice: "auto" } : {}),
        messages: apiMessages,
      });

      for await (const chunk of stream) {
        if (closed) break;
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text delta
        if (delta.content) {
          assistantText += delta.content;
          send("delta", { text: delta.content });
        }

        // Accumulate tool-call argument fragments
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum[idx]) {
              toolCallAccum[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", argsJson: "" };
            }
            const acc = toolCallAccum[idx]!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.argsJson += tc.function.arguments;
          }
        }

        finishReason = choice.finish_reason ?? finishReason;
      }

      // Append the assistant turn (text + any tool_calls) to the history.
      const toolCallsForMsg = Object.values(toolCallAccum);
      const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
        role: "assistant",
        content: assistantText || null,
        ...(toolCallsForMsg.length > 0
          ? {
              tool_calls: toolCallsForMsg.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.argsJson },
              })),
            }
          : {}),
      };
      apiMessages.push(assistantMsg);

      // Execute tool calls and append results, then loop.
      if (finishReason === "tool_calls" && toolCallsForMsg.length > 0 && !closed) {
        for (const tc of toolCallsForMsg) {
          // Every tool_call ID in the assistant turn must have a corresponding
          // tool result message or the OpenAI API rejects the conversation.
          // When the per-turn or cumulative cap is already reached, return a
          // sentinel result rather than executing the fetch.
          if (toolCallsUsed >= MAX_TOOL_CALLS) {
            apiMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: "Tool call limit reached. Please answer from the data already retrieved.",
              }),
            });
            continue;
          }

          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.argsJson || "{}"); } catch { /* keep empty */ }

          const label = toolLabel(tc.name, args);
          send("tool_use", { name: tc.name, label });

          const result = await executeTool(tc.name, args, toolOpts);
          toolCallsUsed++;

          apiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
        // Always make a follow-up call when tool results were appended.
        // If the cap is now reached, the next iteration omits the tools
        // parameter — the model is forced to respond with text instead of
        // calling more tools, and finish_reason will be "stop".
        continueLoop = true;
      }
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

// ─── Tool helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a page_url arg from the model to a full URL that belongs to the site.
 * Accepts paths (/pricing) or full URLs. Returns null if it can't be resolved
 * to a site-owned URL.
 */
function resolvePageUrl(raw: string, site: SiteContext): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") {
      u.hash = "";
      u.search = "";
      if (!urlBelongsToSite(u.href, site)) return null;
      return u.href;
    }
  } catch {
    // fall through — treat as a path
  }
  if (raw.startsWith("/")) {
    try {
      return `https://${site.host}${raw}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Human-readable label for a tool call, shown in the UI while data loads. */
function toolLabel(name: string, args: Record<string, unknown>): string {
  if (name === "get_page_metrics") {
    const raw = typeof args["page_url"] === "string" ? args["page_url"] : "?";
    try { return new URL(raw).pathname; } catch { return raw; }
  }
  if (name === "get_query_metrics") {
    return typeof args["query"] === "string" ? `"${args["query"]}"` : "?";
  }
  return name;
}

/**
 * Execute a tool call from the model. Returns a JSON string (the tool result).
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts: { startDate: string; endDate: string; siteId: number; site: SiteContext },
): Promise<string> {
  const { startDate, endDate, siteId, site } = opts;

  if (name === "get_page_metrics") {
    const raw = typeof args["page_url"] === "string" ? args["page_url"].trim() : "";
    if (!raw) return JSON.stringify({ error: "page_url is required" });
    const pageUrl = resolvePageUrl(raw, site);
    if (!pageUrl) {
      return JSON.stringify({ error: `page_url must be a page on this site (${site.host})` });
    }
    try {
      const [queries, dates] = await Promise.all([
        queryGscDimension({
          siteId,
          startDate,
          endDate,
          dimension: "query",
          pageRegex: pageVariantsRegex(pageUrl),
          rowLimit: 25,
        }),
        queryGscDimension({
          siteId,
          startDate,
          endDate,
          dimension: "date",
          pageRegex: pageVariantsRegex(pageUrl),
          rowLimit: 5000,
        }),
      ]);
      const totals = aggregateTotals(dates);
      return JSON.stringify({
        page: pageUrl,
        range: { startDate, endDate },
        totals: {
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: Number(totals.ctr.toFixed(4)),
          position: Number(totals.position.toFixed(2)),
        },
        topQueries: trim(queries, 20),
      });
    } catch (err) {
      return JSON.stringify({ error: "GSC query failed", detail: String(err) });
    }
  }

  if (name === "get_query_metrics") {
    const query = typeof args["query"] === "string" ? args["query"].trim().slice(0, 500) : "";
    if (!query) return JSON.stringify({ error: "query is required" });
    try {
      const pages = await queryGscDimension({
        siteId,
        startDate,
        endDate,
        dimension: "page",
        queryFilter: { expression: query.toLowerCase(), operator: "equals" },
        rowLimit: 20,
      });
      const totals = aggregateTotals(pages);
      return JSON.stringify({
        query,
        range: { startDate, endDate },
        totals: {
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: Number(totals.ctr.toFixed(4)),
          position: Number(totals.position.toFixed(2)),
        },
        topPages: trim(pages, 15),
      });
    } catch (err) {
      return JSON.stringify({ error: "GSC query failed", detail: String(err) });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_page_metrics",
      description:
        "Fetch GSC performance data (clicks, impressions, CTR, position, top queries) for a specific page on this site. Use when the user asks about a page not already in the data slice.",
      parameters: {
        type: "object",
        properties: {
          page_url: {
            type: "string",
            description:
              "The URL path of the page (e.g. /pricing, /blog/my-post) or a full URL. Must be a page on this site.",
          },
        },
        required: ["page_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_query_metrics",
      description:
        "Fetch GSC metrics for a specific search query — which pages it drives traffic to, and the overall clicks / impressions / CTR / position. Use when the user asks about a keyword not visible in the initial context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The exact search query to look up (e.g. 'wellows seo tool').",
          },
        },
        required: ["query"],
      },
    },
  },
];
