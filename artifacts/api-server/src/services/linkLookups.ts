import { eq, isNotNull, gte, sql, and, or, inArray } from "drizzle-orm";
import {
  db,
  linkLookupsTable,
  linkGraphTable,
  wpPostsTable,
  pageClassificationsTable,
  gscSnapshotsTable,
  linkExcludeListTable,
  type WpPost,
  type PageClassification,
  type LinkLookupCandidate,
  type LinkLookupExistingLink,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { embedText } from "../integrations/openaiEmbed";
import { fetchPageInHouse, logFetchAttempt, assertPublicUrl } from "../integrations/htmlFetch";
import { fetchPageContentViaDataForSeo } from "../integrations/dataforseo";
import { cosineSim, pickAnchorVariants } from "../lib/semanticScorer";

const TOP_N = 15;
const MIN_SIMILARITY = 0.45;
const GSC_LOOKBACK_DAYS = 90;

export type LookupKind = "url" | "text";

export interface LookupInput {
  kind: LookupKind;
  value: string;
  label?: string | null;
}

interface GscAggregate {
  clicks: number;
  impressions: number;
}

async function loadGscAggregates(): Promise<Map<string, GscAggregate>> {
  const cutoff = new Date(Date.now() - GSC_LOOKBACK_DAYS * 86_400_000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const rows = await db
    .select({
      url: gscSnapshotsTable.url,
      clicks: sql<number>`COALESCE(SUM(${gscSnapshotsTable.clicks}), 0)::int`,
      impressions: sql<number>`COALESCE(SUM(${gscSnapshotsTable.impressions}), 0)::int`,
    })
    .from(gscSnapshotsTable)
    .where(gte(gscSnapshotsTable.snapshotDate, cutoffStr))
    .groupBy(gscSnapshotsTable.url);
  const map = new Map<string, GscAggregate>();
  for (const r of rows) {
    map.set(r.url, { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 });
  }
  return map;
}

function compileExcludePattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

function isExcluded(url: string, regexes: RegExp[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return regexes.some((re) => re.test(path) || re.test(url));
}

/**
 * Matching key for comparing URLs across the inventory and the link graph,
 * which can disagree on protocol, a leading "www.", or a trailing slash. We
 * drop all three so the same page compares equal regardless of how it was
 * stored.
 */
function linkKey(u: string): string {
  try {
    const p = new URL(u);
    const host = p.host.replace(/^www\./, "");
    const path = p.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return u;
  }
}

/**
 * Concrete URL spellings used to match the looked-up page against the link
 * graph's stored source_url / target_url. We don't know which protocol / www /
 * trailing-slash variant the crawler persisted, so we enumerate the realistic
 * forms and let an indexed `inArray` match exactly.
 */
function selfUrlForms(urls: string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    let p: URL;
    try {
      p = new URL(raw);
    } catch {
      continue;
    }
    const bareHost = p.host.replace(/^www\./, "");
    const hosts = [bareHost, `www.${bareHost}`];
    const basePath = p.pathname.replace(/\/+$/, "");
    const paths = basePath === "" ? ["/", ""] : [basePath, `${basePath}/`];
    for (const proto of ["https:", "http:"]) {
      for (const h of hosts) {
        for (const pa of paths) {
          out.add(`${proto}//${h}${pa}`);
        }
      }
    }
  }
  return [...out];
}

/**
 * An anchor is "real" when the crawler captured visible link text. Empty/null
 * and the legacy "wp:auto" placeholder don't help an operator, so we drop them.
 */
function hasRealAnchor(a: string | null): a is string {
  if (!a) return false;
  const t = a.trim();
  return t.length > 0 && t.toLowerCase() !== "wp:auto";
}

interface FetchedSummary {
  resolvedUrl: string | null;
  title: string | null;
  h1: string | null;
  excerpt: string | null;
  bodyText: string;
  wordCount: number;
  fetcherUsed: "in_house" | "dataforseo" | "text";
}

async function fetchInput(input: LookupInput): Promise<FetchedSummary> {
  if (input.kind === "text") {
    const text = input.value.trim();
    return {
      resolvedUrl: null,
      title: input.label ?? text.slice(0, 80),
      h1: null,
      excerpt: text.length > 240 ? text.slice(0, 240) + "…" : text,
      bodyText: text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      fetcherUsed: "text",
    };
  }
  // kind === "url": validate the URL points at a public host BEFORE any
  // fetch (so the DataForSEO fallback can't be used to bypass SSRF checks
  // or to spend paid quota on attacker-controlled internal targets).
  await assertPublicUrl(input.value);
  // Then try in-house, fall back to DataForSEO on any failure.
  try {
    const c = await fetchPageInHouse(input.value);
    return {
      resolvedUrl: c.url,
      title: c.title || null,
      h1: c.h1,
      excerpt: c.excerpt || null,
      bodyText: c.bodyText,
      wordCount: c.wordCount,
      fetcherUsed: "in_house",
    };
  } catch (e) {
    logFetchAttempt(input.value, e);
    const c = await fetchPageContentViaDataForSeo(input.value);
    return {
      resolvedUrl: c.url,
      title: c.title || null,
      h1: c.h1,
      excerpt: c.excerpt || null,
      bodyText: c.bodyText,
      wordCount: c.wordCount,
      fetcherUsed: "dataforseo",
    };
  }
}

/**
 * Build the text we hand to the embedder. We bias toward title/h1/excerpt
 * (the strongest topical signal) and then add body up to a safe budget.
 */
function buildEmbedText(f: FetchedSummary): string {
  const parts: string[] = [];
  if (f.title) parts.push(f.title);
  if (f.h1 && f.h1 !== f.title) parts.push(f.h1);
  if (f.excerpt) parts.push(f.excerpt);
  parts.push(f.bodyText.slice(0, 8000));
  return parts.join("\n\n").trim();
}

function pickAnchorForReceiver(
  receiver: WpPost,
  cls: PageClassification | null,
): string | null {
  const { primary } = pickAnchorVariants(cls, receiver);
  return primary || receiver.h1 || receiver.title || null;
}

/**
 * GSC boost: log-scaled blend of clicks + impressions, normalised against
 * the busiest URL in the inventory. Returns a multiplier in [1.0, ~1.6]
 * so semantic relevance stays the dominant signal.
 */
function gscBoostFactor(
  agg: GscAggregate | undefined,
  maxLogClicks: number,
  maxLogImpr: number,
): number {
  if (!agg) return 1.0;
  const c = Math.log1p(agg.clicks);
  const i = Math.log1p(agg.impressions);
  const normC = maxLogClicks > 0 ? c / maxLogClicks : 0;
  const normI = maxLogImpr > 0 ? i / maxLogImpr : 0;
  // Weighted blend: clicks count more than impressions (proven demand).
  const blended = 0.7 * normC + 0.3 * normI;
  return 1 + 0.6 * blended;
}

export async function runLookup(
  inputId: number,
  input: LookupInput,
): Promise<void> {
  const start = Date.now();
  try {
    const fetched = await fetchInput(input);
    const embedSrc = buildEmbedText(fetched);
    if (embedSrc.length < 20) {
      throw new Error("Input has too little text to score (need ≥20 chars after fetch)");
    }
    const embedding = await embedText(embedSrc);

    const [posts, classifications, excludes, gscAggregates, allPosts] = await Promise.all([
      db.select().from(wpPostsTable).where(isNotNull(wpPostsTable.embedding)),
      db.select().from(pageClassificationsTable),
      db.select().from(linkExcludeListTable),
      loadGscAggregates(),
      db
        .select({ url: wpPostsTable.url, title: wpPostsTable.title, h1: wpPostsTable.h1 })
        .from(wpPostsTable),
    ]);
    const clsByUrl = new Map(classifications.map((c) => [c.url, c]));
    // Title lookup for existing-link rows (covers pages without embeddings too).
    const titleByKey = new Map<string, string | null>();
    for (const p of allPosts) titleByKey.set(linkKey(p.url), p.title ?? p.h1 ?? null);
    const excludeRegexes = excludes.map((e) => compileExcludePattern(e.pattern));

    // Pre-compute normalisation constants for the GSC boost.
    let maxLogClicks = 0;
    let maxLogImpr = 0;
    for (const a of gscAggregates.values()) {
      maxLogClicks = Math.max(maxLogClicks, Math.log1p(a.clicks));
      maxLogImpr = Math.max(maxLogImpr, Math.log1p(a.impressions));
    }

    const normalize = (u: string): string => {
      try {
        const parsed = new URL(u);
        const path = parsed.pathname.replace(/\/+$/, "") || "/";
        return `${parsed.protocol}//${parsed.host}${path}`;
      } catch {
        return u;
      }
    };
    const selfUrls = new Set<string>();
    if (fetched.resolvedUrl) selfUrls.add(normalize(fetched.resolvedUrl));
    if (input.kind === "url") selfUrls.add(normalize(input.value));
    const scored: LinkLookupCandidate[] = [];
    for (const p of posts) {
      if (!p.embedding) continue;
      if (selfUrls.has(normalize(p.url))) continue;
      if (isExcluded(p.url, excludeRegexes)) continue;
      const sim = cosineSim(embedding, p.embedding);
      if (sim < MIN_SIMILARITY) continue;
      const agg = gscAggregates.get(p.url);
      const boost = gscBoostFactor(agg, maxLogClicks, maxLogImpr);
      const total = Math.min(1, sim * boost);
      scored.push({
        url: p.url,
        title: p.title ?? p.h1 ?? null,
        similarity: sim,
        gscClicks: agg?.clicks ?? 0,
        gscImpressions: agg?.impressions ?? 0,
        gscBoost: boost,
        total,
        anchorHint: pickAnchorForReceiver(p, clsByUrl.get(p.url) ?? null),
      });
    }
    scored.sort((a, b) => b.total - a.total);

    // Pull the page's EXISTING in-body internal links from the link graph so we
    // can (a) show the operator what is already on the page and (b) mark
    // suggestions that are already linked, leaving the rest as net-new actions.
    // Only meaningful for URL inputs — a topic has no page in the graph yet.
    let existingOutbound: LinkLookupExistingLink[] = [];
    let existingInbound: LinkLookupExistingLink[] = [];
    const outboundLinkedKeys = new Set<string>();
    const inboundLinkedKeys = new Set<string>();
    if (input.kind === "url") {
      const forms = selfUrlForms(
        [fetched.resolvedUrl, input.value].filter((v): v is string => !!v),
      );
      if (forms.length > 0) {
        const edges = await db
          .select({
            source: linkGraphTable.sourceUrl,
            target: linkGraphTable.targetUrl,
            anchor: linkGraphTable.anchorText,
          })
          .from(linkGraphTable)
          .where(
            and(
              eq(linkGraphTable.placement, "content"),
              or(
                inArray(linkGraphTable.sourceUrl, forms),
                inArray(linkGraphTable.targetUrl, forms),
              ),
            ),
          );
        const formSet = new Set(forms);
        const outMap = new Map<string, LinkLookupExistingLink>();
        const inMap = new Map<string, LinkLookupExistingLink>();
        for (const e of edges) {
          const srcIsSelf = formSet.has(e.source);
          const tgtIsSelf = formSet.has(e.target);
          // Outbound: self -> other page.
          if (srcIsSelf && !tgtIsSelf) {
            const key = linkKey(e.target);
            outboundLinkedKeys.add(key);
            const anchor = hasRealAnchor(e.anchor) ? e.anchor : null;
            const prev = outMap.get(key);
            if (!prev) {
              outMap.set(key, { url: e.target, title: titleByKey.get(key) ?? null, anchorText: anchor });
            } else if (!prev.anchorText && anchor) {
              prev.anchorText = anchor;
            }
          }
          // Inbound: other page -> self.
          if (tgtIsSelf && !srcIsSelf) {
            const key = linkKey(e.source);
            inboundLinkedKeys.add(key);
            const anchor = hasRealAnchor(e.anchor) ? e.anchor : null;
            const prev = inMap.get(key);
            if (!prev) {
              inMap.set(key, { url: e.source, title: titleByKey.get(key) ?? null, anchorText: anchor });
            } else if (!prev.anchorText && anchor) {
              prev.anchorText = anchor;
            }
          }
        }
        const byLabel = (a: LinkLookupExistingLink, b: LinkLookupExistingLink) =>
          (a.title ?? a.url).localeCompare(b.title ?? b.url);
        existingOutbound = [...outMap.values()].sort(byLabel);
        existingInbound = [...inMap.values()].sort(byLabel);
      }
    }

    // For a URL input, both directions reduce to the same ranking against
    // the inventory (outbound = "what should this link to"; inbound =
    // "what should link to this"). For a text input we have no destination
    // page yet, so inbound is left empty (nothing to point at). The
    // `alreadyLinked` flag is per-direction: a page can be linked one way
    // (e.g. it already links to us) but still be a useful link the other way.
    const outbound = scored.slice(0, TOP_N).map((c) => ({
      ...c,
      alreadyLinked: outboundLinkedKeys.has(linkKey(c.url)),
    }));
    const inbound =
      input.kind === "url"
        ? scored.slice(0, TOP_N).map((c) => ({
            ...c,
            alreadyLinked: inboundLinkedKeys.has(linkKey(c.url)),
          }))
        : [];

    await db
      .update(linkLookupsTable)
      .set({
        resolvedUrl: fetched.resolvedUrl,
        fetchedTitle: fetched.title,
        fetchedH1: fetched.h1,
        fetchedExcerpt: fetched.excerpt,
        fetchedBodyText: fetched.bodyText.slice(0, 20000),
        wordCount: fetched.wordCount,
        embedding,
        fetcherUsed: fetched.fetcherUsed,
        outboundResults: outbound,
        inboundResults: inbound,
        existingOutbound,
        existingInbound,
        status: "ready",
        error: null,
        durationMs: Date.now() - start,
        completedAt: new Date(),
      })
      .where(eq(linkLookupsTable.id, inputId));
    logger.info(
      { id: inputId, kind: input.kind, outbound: outbound.length, inbound: inbound.length },
      "Link lookup: completed",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ id: inputId, err: msg }, "Link lookup: failed");
    await db
      .update(linkLookupsTable)
      .set({
        status: "failed",
        error: msg,
        durationMs: Date.now() - start,
        completedAt: new Date(),
      })
      .where(eq(linkLookupsTable.id, inputId));
  }
}

export async function createAndRunLookups(
  inputs: LookupInput[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const input of inputs) {
    const [row] = await db
      .insert(linkLookupsTable)
      .values({
        kind: input.kind,
        label: input.label ?? null,
        inputValue: input.value,
        status: "pending",
      })
      .returning({ id: linkLookupsTable.id });
    if (row) ids.push(row.id);
  }
  // Fire-and-forget; the route returns the ids immediately and the client
  // polls GET /link-lookups/:id for results.
  void (async () => {
    for (let i = 0; i < ids.length; i++) {
      await runLookup(ids[i]!, inputs[i]!);
    }
  })();
  return ids;
}
