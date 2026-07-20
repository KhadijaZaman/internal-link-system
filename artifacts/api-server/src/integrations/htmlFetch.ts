import * as cheerio from "cheerio";
import { lookup as dnsLookup } from "node:dns/promises";
import * as net from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { logger } from "../lib/logger";

const UA = "WellowsLinkLookupBot/1.0";
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface FetchedContent {
  url: string;
  title: string;
  h1: string | null;
  excerpt: string;
  bodyText: string;
  wordCount: number;
  source: "in_house";
}

// Exported for unit tests — the SSRF guard's core predicate.
export function isPrivateOrReservedIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const parts = addr.split(".").map((n) => Number(n));
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(lower.slice(7));
    }
    return false;
  }
  return true;
}

interface ValidatedUrl {
  url: URL;
  pinnedIp: string;
  pinnedFamily: 4 | 6;
}

/**
 * Resolves the hostname, validates all returned IPs are public/non-reserved,
 * and returns the URL plus the first resolved IP so the caller can pin the
 * outbound connection to that IP — preventing DNS rebinding attacks.
 */
export async function assertPublicUrl(rawUrl: string): Promise<ValidatedUrl> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Disallowed protocol: ${u.protocol}`);
  }
  const host = u.hostname;
  if (!host) throw new Error("URL missing hostname");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Disallowed hostname: ${host}`);
  }

  let ips: Array<{ address: string; family: number }>;
  if (net.isIP(host)) {
    ips = [{ address: host, family: net.isIP(host) }];
  } else {
    ips = await dnsLookup(host, { all: true }).catch(() => []);
  }

  if (ips.length === 0) throw new Error(`DNS resolution failed for ${host}`);
  for (const ip of ips) {
    if (isPrivateOrReservedIp(ip.address)) {
      throw new Error(`Refusing to fetch private/reserved IP ${ip.address} for ${host}`);
    }
  }

  const first = ips[0]!;
  return {
    url: u,
    pinnedIp: first.address,
    pinnedFamily: first.family === 6 ? 6 : 4,
  };
}

/**
 * Makes an HTTP/HTTPS request directly to `pinnedIp` rather than letting the
 * OS re-resolve the hostname. The original hostname is preserved in the `Host`
 * header and (for TLS) the SNI servername, so certificate validation still
 * works correctly. This closes the DNS-rebinding window between assertPublicUrl
 * and the actual network connection.
 */
function fetchWithPinnedIp(
  u: URL,
  pinnedIp: string,
  signal: AbortSignal,
): Promise<{ status: number; ok: boolean; headers: Map<string, string>; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

    const options: https.RequestOptions = {
      hostname: pinnedIp,
      port,
      path: (u.pathname || "/") + u.search,
      method: "GET",
      headers: {
        Host: u.hostname,
        "User-Agent": UA,
        Accept: "text/html,*/*",
      },
      ...(isHttps ? { servername: u.hostname } : {}),
    };

    const onAbort = () => req.destroy(new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });

    const mod = isHttps ? https : http;
    const req = mod.request(options, (res) => {
      signal.removeEventListener("abort", onAbort);
      const headersMap = new Map<string, string>();
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") {
          headersMap.set(k.toLowerCase(), v);
        } else if (Array.isArray(v) && v.length > 0) {
          headersMap.set(k.toLowerCase(), v[0]!);
        }
      }
      const status = res.statusCode ?? 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: headersMap,
        text() {
          return new Promise<string>((res2, rej2) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => res2(Buffer.concat(chunks).toString("utf8")));
            res.on("error", rej2);
          });
        },
      });
    });

    req.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.end();
  });
}

/**
 * Fetches `rawUrl` safely, following redirects, with each hop:
 *   1. validated through assertPublicUrl (DNS + IP allowlist check)
 *   2. connected to the already-resolved IP so no second DNS lookup occurs
 *
 * This prevents DNS-rebinding bypasses where the hostname resolves differently
 * between the validation call and the actual outbound connection.
 */
async function fetchSafe(
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ res: { status: number; ok: boolean; headers: Map<string, string>; text(): Promise<string> }; finalUrl: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, pinnedIp } = await assertPublicUrl(current);
    const res = await fetchWithPinnedIp(url, pinnedIp, signal);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect from ${current} missing Location`);
      current = new URL(loc, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

function extract(html: string, finalUrl: string): FetchedContent {
  const $ = cheerio.load(html);
  const titleTag = $("title").first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
  const title = ogTitle || titleTag || "";
  const h1 = $("h1").first().text().trim() || null;
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() ?? "";
  const excerpt = metaDesc || ogDesc || "";
  const $body = cheerio.load(html);
  $body("script, style, noscript, nav, header, footer, aside, [aria-hidden=true]").remove();
  const main = $body("main, article, [role=main]").first();
  const root = main.length > 0 ? main : $body("body");
  const text = root.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return {
    url: finalUrl,
    title,
    h1,
    excerpt,
    bodyText: text,
    wordCount: words,
    source: "in_house",
  };
}

export async function fetchPageInHouse(url: string): Promise<FetchedContent> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const { res, finalUrl } = await fetchSafe(url, ctl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) throw new Error(`Non-HTML content-type: ${ct}`);
    const cl = Number(res.headers.get("content-length") ?? "0");
    if (cl > MAX_BODY_BYTES) throw new Error(`Response too large: ${cl} bytes`);
    const html = await res.text();
    if (html.length > MAX_BODY_BYTES) throw new Error(`Body too large: ${html.length} bytes`);
    const out = extract(html, finalUrl);
    if (!out.bodyText || out.wordCount < 20) {
      throw new Error(`Page returned too little text (${out.wordCount} words) — likely JS-rendered`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTML-preserving variant — returns raw HTML alongside extracted body text so
 * downstream consumers (e.g. outline extraction with cheerio) can re-parse the
 * structure. Same safety checks as fetchPageInHouse.
 */
export interface FetchedHtml extends FetchedContent {
  rawHtml: string;
}

export async function fetchPageHtmlInHouse(url: string): Promise<FetchedHtml> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const { res, finalUrl } = await fetchSafe(url, ctl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) throw new Error(`Non-HTML content-type: ${ct}`);
    const cl = Number(res.headers.get("content-length") ?? "0");
    if (cl > MAX_BODY_BYTES) throw new Error(`Response too large: ${cl} bytes`);
    const html = await res.text();
    if (html.length > MAX_BODY_BYTES) throw new Error(`Body too large: ${html.length} bytes`);
    const out = extract(html, finalUrl);
    if (!out.bodyText || out.wordCount < 20) {
      throw new Error(`Page returned too little text (${out.wordCount} words) — likely JS-rendered`);
    }
    return { ...out, rawHtml: html };
  } finally {
    clearTimeout(timer);
  }
}

export function logFetchAttempt(url: string, err: unknown): void {
  logger.warn(
    { url, err: err instanceof Error ? err.message : String(err) },
    "In-house page fetch failed; will try DataForSEO fallback",
  );
}
