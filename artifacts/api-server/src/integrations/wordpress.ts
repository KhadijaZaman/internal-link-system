import * as cheerio from "cheerio";
import { logger } from "../lib/logger";

const UA = "WellowsLinkMapBot/1.0";

export interface WpItem {
  id: number;
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
  outboundInternalLinks: string[];
}

interface WpRaw {
  id: number;
  link: string;
  slug: string;
  date_gmt?: string;
  modified_gmt?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  yoast_head_json?: { og_title?: string; schema?: unknown };
  meta?: Record<string, unknown>;
}

function siteBase(): string {
  const d = process.env["SITE_DOMAIN"];
  if (!d) throw new Error("SITE_DOMAIN must be set");
  return d.startsWith("http") ? d.replace(/\/$/, "") : `https://${d.replace(/\/$/, "")}`;
}

function domainHost(): string {
  return new URL(siteBase()).hostname.replace(/^www\./, "");
}

function stripHtml($: cheerio.CheerioAPI): { text: string; words: number } {
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return { text, words };
}

function extractFocusKeyword(item: WpRaw, $: cheerio.CheerioAPI): string | null {
  const meta = item.meta ?? {};
  for (const key of ["_yoast_wpseo_focuskw", "rank_math_focus_keyword"]) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const og = item.yoast_head_json?.og_title;
  if (typeof og === "string" && og.trim()) return og.trim();
  const h1 = $("h1").first().text().trim();
  return h1 || null;
}

function extractInternalLinks($: cheerio.CheerioAPI, host: string, selfUrl: string): string[] {
  const out = new Set<string>();
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
    const url = abs.toString();
    if (url === selfUrl) return;
    out.add(url);
  });
  return Array.from(out);
}

function parseItem(raw: WpRaw, type: "post" | "page"): WpItem {
  const html = raw.content?.rendered ?? "";
  const $ = cheerio.load(html);
  const { text, words } = stripHtml($);
  const host = domainHost();
  const h1 = $("h1").first().text().trim() || null;
  const h2List: string[] = [];
  $("h2").each((_, el) => {
    const t = $(el).text().trim();
    if (t) h2List.push(t);
  });
  return {
    id: raw.id,
    type,
    url: raw.link,
    slug: raw.slug,
    title: cheerio.load(raw.title?.rendered ?? "")("body").text().trim(),
    publishDate: raw.date_gmt ? new Date(raw.date_gmt + "Z") : null,
    modifiedDate: raw.modified_gmt ? new Date(raw.modified_gmt + "Z") : null,
    excerpt: cheerio.load(raw.excerpt?.rendered ?? "")("body").text().trim(),
    bodyText: text,
    h1,
    h2List,
    focusKeyword: extractFocusKeyword(raw, $),
    wordCount: words,
    outboundInternalLinks: extractInternalLinks($, host, raw.link),
  };
}

async function fetchPaginated(
  endpoint: "posts" | "pages",
): Promise<WpItem[]> {
  const base = siteBase();
  const perPage = 50;
  const out: WpItem[] = [];
  let totalPages = Infinity;
  for (let page = 1; page <= totalPages; page++) {
    const url = `${base}/wp-json/wp/v2/${endpoint}?per_page=${perPage}&page=${page}&_embed=1`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 400 || res.status === 404) break;
    if (!res.ok) throw new Error(`WP ${endpoint} page ${page} failed: ${res.status}`);
    if (page === 1) {
      const tp = Number(res.headers.get("x-wp-totalpages") ?? "0");
      if (Number.isFinite(tp) && tp > 0) totalPages = tp;
    }
    const items = (await res.json()) as WpRaw[];
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      try {
        out.push(parseItem(it, endpoint === "posts" ? "post" : "page"));
      } catch (e) {
        logger.warn({ id: it?.id, err: e }, "WP parse failed");
      }
    }
    if (items.length < perPage) break;
  }
  return out;
}

export async function fetchAllWpContent(): Promise<WpItem[]> {
  const [posts, pages] = await Promise.all([
    fetchPaginated("posts").catch((e) => {
      logger.warn({ err: e }, "WP posts fetch failed");
      return [] as WpItem[];
    }),
    fetchPaginated("pages").catch((e) => {
      logger.warn({ err: e }, "WP pages fetch failed");
      return [] as WpItem[];
    }),
  ]);
  return [...posts, ...pages];
}
