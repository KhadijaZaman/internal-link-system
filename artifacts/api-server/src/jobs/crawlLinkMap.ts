import * as cheerio from "cheerio";
import { and, eq, sql } from "drizzle-orm";
import {
  classifyPlacement,
  placementRank,
  type LinkPlacement,
} from "../lib/linkPlacement";
import {
  db,
  linkGraphTable,
  linkStatsTable,
  crawlProgressTable,
  wpPostsTable,
  pagesTable,
  urlBlocklistTable,
} from "@workspace/db";
import {
  canonicalPath,
  canonicalUrl,
  isBlockedPath,
  loadBlockRegexes,
} from "../lib/urlCanon";
import { sectionFor } from "../lib/sections";
import { getLegacySite } from "../lib/site";
import { chainActionQueueRecompute } from "../services/actionQueue";
import { logger } from "../lib/logger";

const CHUNK_SIZE = 200;
const CONCURRENCY = 5;
const POLITE_DELAY_MS = 1000;
const UA = "WellowsLinkMapBot/1.0";

function normalizeUrl(base: string, href: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function getDomain(): string {
  const d = process.env["SITE_DOMAIN"];
  if (!d) throw new Error("SITE_DOMAIN must be set");
  return d.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function getSitemap(): string {
  const s = process.env["SITEMAP_URL"];
  if (!s) throw new Error("SITEMAP_URL must be set");
  return s;
}

/**
 * Returns true only when the URL uses http/https and its host (ignoring a
 * leading "www.") matches the configured site domain.  This is the central
 * guard that prevents SSRF: every URL sourced from a sitemap must pass this
 * check before the server is allowed to fetch it.
 */
function isAllowedUrl(url: string, domain: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // `domain` comes from getDomain() which strips the scheme but may retain a
  // port (e.g. "localhost:3000" or "example.com:8443"). Strip any trailing
  // port so the comparison is hostname-only on both sides, matching
  // `parsed.hostname` which never includes a port.
  const urlHost = parsed.hostname.replace(/^www\./, "");
  const allowedHost = (domain.split(":")[0] ?? domain).replace(/^www\./, "");
  return urlHost === allowedHost;
}

const MAX_REDIRECTS = 5;

/**
 * Fetches `startUrl` with manual redirect handling so that every redirect hop
 * is validated against the allowed domain BEFORE the next request is issued.
 * This prevents SSRF via redirect chains: unlike `redirect: "follow"`, the
 * server never contacts an off-domain host, even transiently.
 *
 * Throws when any hop would leave the allowed origin or exceeds MAX_REDIRECTS.
 */
async function fetchWithSafeRedirects(
  startUrl: string,
  domain: string,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Redirect from ${current} has no Location header`);
      }
      const next = new URL(location, current).toString();
      if (!isAllowedUrl(next, domain)) {
        throw new Error(`Redirect to "${next}" is not allowed for domain "${domain}"`);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${startUrl}`);
}

async function fetchSitemapUrls(sitemapUrl: string, domain: string): Promise<string[]> {
  const res = await fetchWithSafeRedirects(sitemapUrl, domain, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($("sitemapindex").length > 0) {
    const children: string[] = [];
    $("sitemap > loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (isAllowedUrl(loc, domain)) {
        children.push(loc);
      } else {
        logger.warn({ loc }, "Crawl: skipping disallowed sitemap index loc");
      }
    });
    // Propagate child sitemap failures — silently returning [] produces a
    // partial crawl with stale edges and no visible failure signal.
    const nested = await Promise.all(
      children.map(async (c) => {
        try {
          return await fetchSitemapUrls(c, domain);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Child sitemap ${c} failed: ${msg}`);
        }
      }),
    );
    return nested.flat();
  }
  const urls: string[] = [];
  $("url > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (isAllowedUrl(loc, domain)) {
      urls.push(loc);
    } else {
      logger.warn({ loc }, "Crawl: skipping disallowed sitemap url loc");
    }
  });
  return urls;
}

interface PageData {
  title: string | null;
  h1: string | null;
  links: Array<{ target: string; anchor: string; surrounding: string; placement: LinkPlacement }>;
}

interface FetchResult {
  /** Canonical URL / path of the fetched page. */
  url: string;
  path: string;
  status: number;
  /** Parsed page, or null when the response was not OK / not HTML. */
  page: PageData | null;
}

async function fetchPage(
  rawUrl: string,
  domain: string,
  block: RegExp[],
  siteHost: string,
): Promise<FetchResult | null> {
  // URL hygiene: everything stored downstream uses the canonical form.
  const path = canonicalPath(rawUrl, siteHost);
  if (!path || isBlockedPath(path, block)) return null;
  const url = canonicalUrl(path, siteHost);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetchWithSafeRedirects(rawUrl, domain, {
      headers: { "User-Agent": UA },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { url, path, status: res.status, page: null };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return { url, path, status: res.status, page: null };
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim() || null;
    const h1 = $("h1").first().text().trim() || null;
    const links: PageData["links"] = [];
    const seen = new Map<string, number>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const resolved = normalizeUrl(rawUrl, href);
      if (!resolved) return;
      // canonicalPath returns null for foreign hosts, so this doubles as the
      // same-domain check; blocklisted targets never enter the link graph.
      const targetPath = canonicalPath(resolved, siteHost);
      if (!targetPath || isBlockedPath(targetPath, block)) return;
      const target = canonicalUrl(targetPath, siteHost);
      if (target === url) return;
      const anchor = ($(el).text() || "").trim().slice(0, 150);
      const surrounding = ($(el).parent().text() || "").trim().slice(0, 80);
      const placement = classifyPlacement($, el);
      // De-dupe across placements: prefer content > nav > header > footer.
      // This avoids a content link being silently downgraded just because the
      // same href also appears in a sticky header on the same page.
      const key = `${target}|${anchor}`;
      const prevIdx = seen.get(key);
      if (prevIdx !== undefined) {
        const prev = links[prevIdx]!;
        if (placementRank(placement) < placementRank(prev.placement)) {
          prev.placement = placement;
        }
        return;
      }
      seen.set(key, links.length);
      links.push({ target, anchor, surrounding, placement });
    });
    return { url, path, status: res.status, page: { title, h1, links } };
  } catch (e) {
    logger.warn({ url: rawUrl, err: e instanceof Error ? e.message : String(e) }, "Page fetch failed");
    return null;
  }
}

async function processWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= items.length) return;
      results[myIdx] = await fn(items[myIdx]!);
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export async function recomputeStats(siteId: number): Promise<void> {
  // Internal-linking stats (orphan / over-linked / PageRank) consider ONLY
  // content-placement edges. Nav/header/footer links are stored for
  // reporting but excluded here so a sitewide footer doesn't make every
  // page look "well-linked" and a missing menu entry doesn't fake-orphan a
  // page that has plenty of in-body links.
  await db.execute(sql`
    WITH counts AS (
      SELECT url, COALESCE(inb, 0) AS inb, COALESCE(outb, 0) AS outb FROM (
        SELECT u AS url FROM (
          SELECT DISTINCT source_url AS u FROM link_graph
          WHERE placement = 'content' AND site_id = ${siteId}
          UNION SELECT DISTINCT target_url AS u FROM link_graph
          WHERE placement = 'content' AND site_id = ${siteId}
        ) all_urls
      ) urls
      LEFT JOIN (
        SELECT target_url AS u, COUNT(*) AS inb FROM link_graph
        WHERE placement = 'content' AND site_id = ${siteId} GROUP BY target_url
      ) i ON i.u = urls.url
      LEFT JOIN (
        SELECT source_url AS u, COUNT(*) AS outb FROM link_graph
        WHERE placement = 'content' AND site_id = ${siteId} GROUP BY source_url
      ) o ON o.u = urls.url
    )
    INSERT INTO link_stats (url, site_id, inbound_count, outbound_count, is_orphan, is_dead_end, updated_at)
    SELECT url, ${siteId}, inb, outb,
      -- Orphan/dead-end badges apply only to real, live pages. The link graph
      -- also collects "ghost" URLs (old redirecting addresses, ?utm_ tracking
      -- variants, /page/N/ pagination) — those aren't pages needing links.
      -- Real page = known to the CMS (wp_posts) or reported live by Search
      -- Console (inventory).
      inb = 0 AND (
        EXISTS (SELECT 1 FROM wp_posts w WHERE w.url = counts.url AND w.site_id = ${siteId})
        OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.url = counts.url AND i2.site_id = ${siteId})
      ),
      outb = 0 AND (
        EXISTS (SELECT 1 FROM wp_posts w WHERE w.url = counts.url AND w.site_id = ${siteId})
        OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.url = counts.url AND i2.site_id = ${siteId})
      ),
      NOW() FROM counts
    ON CONFLICT (url, site_id) DO UPDATE SET
      inbound_count = EXCLUDED.inbound_count,
      outbound_count = EXCLUDED.outbound_count,
      is_orphan = EXCLUDED.is_orphan,
      is_dead_end = EXCLUDED.is_dead_end,
      updated_at = NOW()
  `);

  // Reset pages that no longer have ANY content edge. The upsert above only
  // touches URLs present in a content-placement edge, so a page whose only
  // "content" links were reclassified out (e.g. to sidebar) would otherwise
  // keep a stale row showing inbound/outbound > 0 and is_orphan = false. Zero
  // them so dashboard, backlink and orphan/dead-end views honour the
  // "editorial body links only" rule. NOT EXISTS is used over NOT IN to stay
  // correct if a URL column ever holds NULL.
  await db.execute(sql`
    UPDATE link_stats ls SET
      inbound_count = 0,
      outbound_count = 0,
      internal_pagerank = 0,
      -- Same real-page rule as the upsert above: ghost URLs (redirects, utm
      -- variants, pagination) are zeroed but never flagged orphan/dead-end.
      is_orphan = (
        EXISTS (SELECT 1 FROM wp_posts w WHERE w.url = ls.url AND w.site_id = ${siteId})
        OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.url = ls.url AND i2.site_id = ${siteId})
      ),
      is_dead_end = (
        EXISTS (SELECT 1 FROM wp_posts w WHERE w.url = ls.url AND w.site_id = ${siteId})
        OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.url = ls.url AND i2.site_id = ${siteId})
      ),
      updated_at = NOW()
    WHERE ls.site_id = ${siteId}
      AND NOT EXISTS (
        SELECT 1 FROM link_graph lg
        WHERE lg.placement = 'content'
          AND lg.site_id = ${siteId}
          AND (lg.source_url = ls.url OR lg.target_url = ls.url)
      )
  `);

  // PageRank computation — content links only, same reasoning as above.
  const edges = await db
    .select({ source: linkGraphTable.sourceUrl, target: linkGraphTable.targetUrl })
    .from(linkGraphTable)
    .where(and(eq(linkGraphTable.siteId, siteId), eq(linkGraphTable.placement, "content")));
  const urls = new Set<string>();
  const out = new Map<string, string[]>();
  for (const e of edges) {
    urls.add(e.source);
    urls.add(e.target);
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const N = urls.size;
  if (N === 0) return;
  const d = 0.85;
  let pr = new Map<string, number>();
  for (const u of urls) pr.set(u, 1 / N);
  for (let i = 0; i < 10; i++) {
    const next = new Map<string, number>();
    for (const u of urls) next.set(u, (1 - d) / N);
    for (const [src, targets] of out) {
      const share = (pr.get(src) ?? 0) / targets.length;
      for (const t of targets) {
        next.set(t, (next.get(t) ?? 0) + d * share);
      }
    }
    pr = next;
  }
  for (const [url, rank] of pr) {
    await db
      .insert(linkStatsTable)
      .values({ url, siteId, internalPagerank: rank })
      .onConflictDoUpdate({
        target: [linkStatsTable.url, linkStatsTable.siteId],
        set: { internalPagerank: rank, updatedAt: new Date() },
      });
  }
}

export async function runCrawlLinkMap(): Promise<void> {
  // Link-map crawl stays legacy-site-only until per-site job scheduling lands.
  const site = await getLegacySite();
  const domain = getDomain();
  const sitemapUrl = getSitemap();
  if (!isAllowedUrl(sitemapUrl, domain)) {
    throw new Error(`SITEMAP_URL "${sitemapUrl}" is not allowed for domain "${domain}"`);
  }
  logger.info({ sitemapUrl }, "Crawl: fetching sitemap");
  const allUrls = await fetchSitemapUrls(sitemapUrl, domain);
  logger.info({ count: allUrls.length }, "Crawl: sitemap urls");

  await db
    .insert(crawlProgressTable)
    .values({ id: 1, siteId: site.id, lastOffset: 0 })
    .onConflictDoNothing();
  const progress = await db
    .select()
    .from(crawlProgressTable)
    .where(eq(crawlProgressTable.siteId, site.id));
  const offset = progress[0]?.lastOffset ?? 0;
  const chunk = allUrls.slice(offset, offset + CHUNK_SIZE);
  logger.info({ offset, chunk: chunk.length }, "Crawl: chunk");

  // WP is canonical: skip any source URL that already exists in wp_posts.
  // Sitemap crawl only fills gaps for pages the WP REST crawler did not cover.
  // Comparison happens on canonical URLs since wp_posts stores those.
  const block = await loadBlockRegexes(site.id);
  const wpRows = await db
    .select({ url: wpPostsTable.url })
    .from(wpPostsTable)
    .where(eq(wpPostsTable.siteId, site.id));
  const wpSources = new Set(wpRows.map((r) => r.url));
  const sitemapChunk = chunk.filter((u) => {
    const p = canonicalPath(u, site.host);
    return p !== null && !wpSources.has(canonicalUrl(p, site.host));
  });
  logger.info(
    { skippedWp: chunk.length - sitemapChunk.length, fetching: sitemapChunk.length },
    "Crawl: WP-canonical filter",
  );

  const results = await processWithConcurrency(sitemapChunk, CONCURRENCY, (u) =>
    fetchPage(u, domain, block, site.host),
  );
  let inserted = 0;
  let blocked404 = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.status === 404) {
      // Spec: any path that 404s joins the blocklist so no ingestion path
      // (GSC, GA4, crawler) keeps reporting on a dead page.
      try {
        await db
          .insert(urlBlocklistTable)
          .values({ pattern: r.path, siteId: site.id, note: "404 (crawler)", source: "crawler-404" })
          .onConflictDoNothing();
        // Record the 404 on any existing pages-registry row so the shared
        // content-pages count (status < 400) stops counting this page.
        await db
          .update(pagesTable)
          .set({ httpStatus: 404 })
          .where(and(eq(pagesTable.siteId, site.id), eq(pagesTable.path, r.path)));
        blocked404++;
      } catch (e) {
        logger.warn({ err: e, path: r.path }, "Crawl: blocklist 404 upsert failed");
      }
      continue;
    }
    // Canonical page registry: record what the crawler saw for this path.
    try {
      await db
        .insert(pagesTable)
        .values({
          path: r.path,
          url: r.url,
          siteId: site.id,
          title: r.page?.title ?? null,
          section: sectionFor(r.url),
          inSitemap: true,
          httpStatus: r.status,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pagesTable.path, pagesTable.siteId],
          set: {
            ...(r.page?.title ? { title: r.page.title } : {}),
            section: sectionFor(r.url),
            inSitemap: true,
            httpStatus: r.status,
            updatedAt: new Date(),
          },
        });
    } catch (e) {
      logger.warn({ err: e, path: r.path }, "Crawl: pages upsert failed");
    }
    const p = r.page;
    if (!p) continue;
    // Source is canonical: clear this page's prior edges before re-inserting
    // the freshly-classified set. Without this, the onConflictDoNothing below
    // would preserve a stale `placement` (e.g. a sidebar link previously
    // tagged "content"), so re-classification would never take effect on a
    // re-crawl. Only successfully-fetched pages are cleared, so a transient
    // fetch failure never wipes good data.
    try {
      await db
        .delete(linkGraphTable)
        .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.sourceUrl, r.url)));
    } catch (e) {
      logger.warn({ err: e, src: r.url }, "Crawl: clear prior edges failed");
    }
    for (const l of p.links) {
      try {
        const ins = await db
          .insert(linkGraphTable)
          .values({
            sourceUrl: r.url,
            targetUrl: l.target,
            siteId: site.id,
            anchorText: l.anchor || null,
            surroundingText: l.surrounding || null,
            placement: l.placement,
          })
          .onConflictDoNothing()
          .returning({ id: linkGraphTable.id });
        if (ins.length > 0) inserted++;
      } catch (e) {
        logger.warn({ err: e }, "Insert link failed");
      }
    }
  }
  if (blocked404 > 0) logger.info({ blocked404 }, "Crawl: 404 paths blocklisted");
  const nextOffset = offset + CHUNK_SIZE >= allUrls.length ? 0 : offset + CHUNK_SIZE;
  await db
    .insert(crawlProgressTable)
    .values({ id: 1, siteId: site.id, lastOffset: nextOffset, lastRunAt: new Date() })
    .onConflictDoUpdate({
      target: [crawlProgressTable.id, crawlProgressTable.siteId],
      set: { lastOffset: nextOffset, lastRunAt: new Date() },
    });
  logger.info({ inserted, nextOffset }, "Crawl: chunk done");

  await recomputeStats(site.id);
  logger.info("Crawl: stats recomputed");

  // Orphan/dead-end flags may have changed — refresh the action queue.
  await chainActionQueueRecompute("crawl_link_map", site.id);
}
