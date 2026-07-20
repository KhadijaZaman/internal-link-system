import * as cheerio from "cheerio";
import { logger } from "../lib/logger";
import {
  classifyPlacement,
  placementRank,
  type LinkPlacement,
} from "../lib/linkPlacement";

const UA = "WellowsLinkMapBot/1.0";
const MAX_REDIRECTS = 5;
const PAGE_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 5;
const POLITE_DELAY_MS = 500;

export interface SitemapItem {
  type: "post" | "page";
  url: string;
  slug: string;
  title: string;
  publishDate: Date | null;
  modifiedDate: Date | null;
  excerpt: string;
  bodyText: string;
  h1: string | null;
  h2List: string[];
  focusKeyword: string | null;
  wordCount: number;
  /**
   * Outbound internal links discovered on the page, tagged by where on the
   * page they appeared. Consumers should filter to `placement === "content"`
   * for any internal-linking decision; chrome placements are kept so we
   * can report breakdowns.
   */
  outboundInternalLinks: Array<{
    url: string;
    placement: LinkPlacement;
    anchorText: string;
  }>;
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

function isAllowedUrl(url: string, domain: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const urlHost = parsed.hostname.replace(/^www\./, "");
  const allowedHost = (domain.split(":")[0] ?? domain).replace(/^www\./, "");
  return urlHost === allowedHost;
}

/**
 * SSRF-safe fetch: validates each redirect hop against the allowed domain
 * before issuing the next request. Never contacts an off-domain host.
 */
async function fetchSafe(
  startUrl: string,
  domain: string,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  // Validate the initial URL before issuing any request. Without this, a
  // misconfigured or attacker-influenced SITEMAP_URL could cause the very
  // first hop to leave the allowed origin before any check runs.
  if (!isAllowedUrl(startUrl, domain)) {
    throw new Error(`Start URL "${startUrl}" not allowed for domain "${domain}"`);
  }
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect from ${current} has no Location`);
      const next = new URL(location, current).toString();
      if (!isAllowedUrl(next, domain)) {
        throw new Error(`Redirect to "${next}" not allowed for "${domain}"`);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${startUrl}`);
}

interface SitemapUrlEntry {
  loc: string;
  lastmod: string | null;
}

async function fetchSitemapEntries(
  sitemapUrl: string,
  domain: string,
): Promise<SitemapUrlEntry[]> {
  const res = await fetchSafe(sitemapUrl, domain, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($("sitemapindex").length > 0) {
    const children: string[] = [];
    $("sitemap > loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (isAllowedUrl(loc, domain)) children.push(loc);
      else logger.warn({ loc }, "Sitemap index loc disallowed");
    });
    // A failed child sitemap must fail the whole discovery. Silently
    // returning [] here once caused a partial crawl that mass-deleted the
    // post inventory and link graph downstream (post-sitemap.xml failed one
    // night; the crawl "reconciled" against the 74 surviving URLs).
    const nested = await Promise.all(
      children.map(async (c) => {
        try {
          return await fetchSitemapEntries(c, domain);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Child sitemap ${c} failed: ${msg}`);
        }
      }),
    );
    return nested.flat();
  }
  const out: SitemapUrlEntry[] = [];
  $("url").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    if (!loc || !isAllowedUrl(loc, domain)) return;
    const lastmod = $(el).find("lastmod").first().text().trim() || null;
    out.push({ loc, lastmod });
  });
  return out;
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "/";
  } catch {
    return url;
  }
}

function classifyType(url: string): "post" | "page" {
  // Heuristic: blog/article paths are posts, everything else is a page.
  // Tweak via path conventions if needed.
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (/(^|\/)(blog|articles?|news|posts?|insights?|guides?)\//.test(p)) {
      return "post";
    }
    return "page";
  } catch {
    return "page";
  }
}

function extractInternalLinks(
  $: cheerio.CheerioAPI,
  host: string,
  selfUrl: string,
): Array<{ url: string; placement: LinkPlacement; anchorText: string }> {
  // De-dup by URL while keeping the strongest placement seen
  // (content > nav > header > footer). A footer link that also appears in
  // the article body must end up tagged "content", never get demoted.
  // Alongside placement we keep the visible anchor text of the chosen
  // occurrence, preferring the strongest placement and, within the same
  // placement, the first non-empty anchor text.
  const best = new Map<string, { placement: LinkPlacement; anchorText: string }>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: URL;
    try {
      abs = new URL(href, selfUrl);
    } catch {
      return;
    }
    if (abs.hostname.replace(/^www\./, "") !== host) return;
    abs.hash = "";
    const u = abs.toString();
    if (u === selfUrl) return;
    const placement = classifyPlacement($, el);
    const anchorText = $(el).text().replace(/\s+/g, " ").trim().slice(0, 300);
    const prev = best.get(u);
    if (prev === undefined || placementRank(placement) < placementRank(prev.placement)) {
      best.set(u, { placement, anchorText });
    } else if (
      placementRank(placement) === placementRank(prev.placement) &&
      prev.anchorText === "" &&
      anchorText !== ""
    ) {
      best.set(u, { placement, anchorText });
    }
  });
  return Array.from(best, ([url, v]) => ({
    url,
    placement: v.placement,
    anchorText: v.anchorText,
  }));
}

function extractMeta(
  $: cheerio.CheerioAPI,
): { title: string; h1: string | null; h2: string[]; excerpt: string; focusKw: string | null } {
  const titleTag = $("title").first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
  const title = ogTitle || titleTag || "";
  const h1 = $("h1").first().text().trim() || null;
  const h2: string[] = [];
  $("h2").each((_, el) => {
    const t = $(el).text().trim();
    if (t) h2.push(t);
  });
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() ?? "";
  const excerpt = metaDesc || ogDesc || "";
  const keywords = $('meta[name="keywords"]').attr("content")?.trim() ?? "";
  const focusKw = keywords ? keywords.split(",")[0]?.trim() || null : null;
  return { title, h1, h2, excerpt, focusKw };
}

function extractBody($: cheerio.CheerioAPI): { text: string; words: number } {
  // Strip elements that pollute body text with chrome/nav/cookie banners.
  $("script, style, noscript, nav, header, footer, aside, [aria-hidden=true]").remove();
  const main = $("main, article, [role=main]").first();
  const root = main.length > 0 ? main : $("body");
  const text = root.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return { text, words };
}

async function fetchPage(url: string, domain: string): Promise<SitemapItem | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS);
    const res = await fetchSafe(url, domain, {
      headers: { "User-Agent": UA },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const { title, h1, h2, excerpt, focusKw } = extractMeta($);
    const { text, words } = extractBody($);
    const links = extractInternalLinks(
      cheerio.load(html), // re-parse so previous .remove() doesn't strip <a>s
      domain.replace(/^www\./, ""),
      url,
    );
    return {
      url,
      type: classifyType(url),
      slug: slugFromUrl(url),
      title,
      publishDate: null,
      modifiedDate: null,
      excerpt,
      bodyText: text,
      h1,
      h2List: h2,
      focusKeyword: focusKw,
      wordCount: words,
      outboundInternalLinks: links,
    };
  } catch (e) {
    logger.warn(
      { url, err: e instanceof Error ? e.message : String(e) },
      "Sitemap content fetch failed",
    );
    return null;
  }
}

async function processConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
      }
    }),
  );
  return out;
}

export async function fetchAllSitemapContent(): Promise<SitemapItem[]> {
  const domain = getDomain();
  const sitemap = getSitemap();
  const entries = await fetchSitemapEntries(sitemap, domain);
  logger.info({ count: entries.length }, "Sitemap content: urls discovered");

  const items = await processConcurrent(entries, FETCH_CONCURRENCY, async (entry) => {
    const item = await fetchPage(entry.loc, domain);
    if (item && entry.lastmod) {
      const d = new Date(entry.lastmod);
      if (!isNaN(d.getTime())) item.modifiedDate = d;
    }
    return item;
  });
  const successful = items.filter((it): it is SitemapItem => it !== null);
  logger.info(
    { discovered: entries.length, fetched: successful.length },
    "Sitemap content: fetch complete",
  );
  return successful;
}
