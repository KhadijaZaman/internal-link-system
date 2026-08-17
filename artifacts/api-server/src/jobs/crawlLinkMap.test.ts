import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for fetchSitemapUrls failure propagation inside runCrawlLinkMap.
 *
 * fetchSitemapUrls is private, so failures are exercised via runCrawlLinkMap.
 * Global fetch is stubbed so no real network calls are made.
 *
 * Two critical contracts are verified:
 *   1. A 500 on the root sitemap causes runCrawlLinkMap to reject.
 *   2. A 500 on a child sitemap (sitemap index entry) also causes rejection,
 *      per the explicit propagation comment at crawlLinkMap.ts line 134.
 *
 * These tests ensure that a future refactor of fetchSitemapUrls cannot
 * silently swallow errors and produce an empty / partial crawl.
 */

// ── mock heavy collaborators so no real DB / queue / crypto is touched ───────

vi.mock("@workspace/db", () => {
  const mockDb = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
    execute: vi.fn().mockResolvedValue([]),
  };
  return {
    db: mockDb,
    linkGraphTable: {},
    linkStatsTable: {},
    crawlProgressTable: {},
    wpPostsTable: {},
    pagesTable: {},
    urlBlocklistTable: {},
  };
});

vi.mock("../lib/jobBudget", () => ({
  budgetForSite: vi.fn().mockReturnValue({
    take: vi.fn().mockReturnValue(true),
    remaining: vi.fn().mockReturnValue(1000),
    anyExhausted: vi.fn().mockReturnValue(false),
    summary: vi.fn().mockReturnValue({}),
  }),
  registerBudget: vi.fn(),
}));

vi.mock("../services/actionQueue", () => ({
  chainActionQueueRecompute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/urlCanon", () => ({
  canonicalPath: vi.fn().mockImplementation((url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return null;
    }
  }),
  canonicalUrl: vi.fn().mockImplementation((_path: string, host: string) => `https://${host}${_path}`),
  isBlockedPath: vi.fn().mockReturnValue(false),
  loadBlockRegexes: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/sections", () => ({
  sectionFor: vi.fn().mockReturnValue("content"),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/linkPlacement", () => ({
  classifyPlacement: vi.fn().mockReturnValue("content"),
  placementRank: vi.fn().mockReturnValue(0),
}));

vi.mock("../lib/site", () => ({
  LEGACY_SITE_ID: 1,
  listSchedulableSites: vi.fn().mockResolvedValue([]),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal fetch-compatible Response stub */
function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_name: string) => null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Response stub for redirect hops (3xx with a Location header). */
function makeRedirectResponse(status: number, location: string): Response {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "location" ? location : null),
    },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

const SITEMAP_INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
</sitemapindex>`;

const LEAF_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-a/</loc></url>
  <url><loc>https://example.com/page-b/</loc></url>
</urlset>`;

/** A site context that bypasses env-var lookups (non-legacy id, explicit sitemapUrl). */
const fakeSite = {
  id: 99,
  host: "example.com",
  domain: "example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  displayName: "Example",
  ownerUserId: null,
  maxCrawlPages: 1000,
  maxLlmCallsPerRun: 50,
  maxSerpQueriesPerRun: 50,
};

// ── import after mocks ────────────────────────────────────────────────────────

import { runCrawlLinkMap } from "./crawlLinkMap";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("crawlLinkMap — fetchSitemapUrls failure propagation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the root sitemap returns HTTP 500", async () => {
    // fetch is called once: for the root sitemap URL; it returns 500.
    vi.mocked(fetch).mockResolvedValue(makeResponse(500, "Internal Server Error"));

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("Sitemap fetch failed: 500");
  });

  it("rejects when the root sitemap returns HTTP 404", async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(404, "Not Found"));

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("Sitemap fetch failed: 404");
  });

  it("rejects when the root sitemap is unreachable (fetch throws a network error)", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("fetch failed: ECONNREFUSED");
  });

  it("rejects when a child sitemap in a sitemap index returns HTTP 500", async () => {
    // First fetch: root sitemap index — succeeds.
    // Second fetch: child sitemap — fails with 500.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(200, SITEMAP_INDEX_XML))
      .mockResolvedValueOnce(makeResponse(500, "Internal Server Error"));

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow(
      /Child sitemap https:\/\/example\.com\/sitemap-pages\.xml failed/,
    );
  });

  it("child-sitemap rejection message includes the underlying fetch failure status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(200, SITEMAP_INDEX_XML))
      .mockResolvedValueOnce(makeResponse(503, "Service Unavailable"));

    let caught: Error | null = null;
    try {
      await runCrawlLinkMap(fakeSite);
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }

    expect(caught).not.toBeNull();
    // The error wraps both the child URL and the underlying status.
    expect(caught!.message).toMatch(/Child sitemap https:\/\/example\.com\/sitemap-pages\.xml failed/);
    expect(caught!.message).toMatch(/Sitemap fetch failed: 503/);
  });

  it("resolves successfully when both root (sitemap index) and child sitemaps return 200", async () => {
    // Root sitemap is an index pointing to one child; child is a leaf urlset.
    // All subsequent page fetches are mocked to return HTML so no further throw.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(200, SITEMAP_INDEX_XML)) // root sitemap index
      .mockResolvedValueOnce(makeResponse(200, LEAF_SITEMAP_XML)); // child sitemap

    // After sitemaps are fetched, runCrawlLinkMap proceeds to fetch pages.
    // For this test we don't care about page-level results; we just confirm
    // that fetchSitemapUrls itself did not throw.  Any subsequent fetch for
    // individual pages is fine to return a generic 200 or be absent from the
    // queue — the WP-canonical filter or concurrency pool will handle them.
    // Provide a fallback so page fetches don't throw "no mock remaining".
    vi.mocked(fetch).mockResolvedValue(makeResponse(200, "<html><body></body></html>"));

    // Should resolve — not throw — when sitemaps are healthy.
    await expect(runCrawlLinkMap(fakeSite)).resolves.toBeUndefined();
  });
});

// ── SSRF guard: redirect hop validation ───────────────────────────────────────

describe("crawlLinkMap — fetchWithSafeRedirects SSRF guard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws with 'not allowed for domain' when a sitemap redirect leads to an off-domain URL", async () => {
    // The root sitemap fetch returns a 301 pointing to an off-domain host.
    // fetchWithSafeRedirects must reject before following the hop.
    vi.mocked(fetch).mockResolvedValueOnce(
      makeRedirectResponse(301, "https://evil.example.org/steal"),
    );

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("not allowed for domain");
  });

  it("throws with 'not allowed for domain' when a redirect uses http pointing to a different host", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeRedirectResponse(302, "http://attacker.com/payload"),
    );

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("not allowed for domain");
  });

  it("throws with 'not allowed for domain' when a redirect leads to an internal IP (169.254.x.x)", async () => {
    // An SSRF attempt targeting link-local metadata; the host does not match
    // example.com so isAllowedUrl returns false before any DNS is consulted.
    vi.mocked(fetch).mockResolvedValueOnce(
      makeRedirectResponse(301, "http://169.254.169.254/latest/meta-data/"),
    );

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("not allowed for domain");
  });

  it("follows a same-domain redirect and proceeds with the crawl", async () => {
    // First call: root sitemap returns 301 → same-domain canonical URL.
    // Second call: the redirect target returns a valid leaf sitemap.
    // Subsequent calls: page fetches return generic HTML.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeRedirectResponse(301, "https://example.com/sitemap-canonical.xml"),
      )
      .mockResolvedValueOnce(makeResponse(200, LEAF_SITEMAP_XML))
      .mockResolvedValue(makeResponse(200, "<html><body></body></html>"));

    // The redirect is within the allowed domain so runCrawlLinkMap must not throw.
    await expect(runCrawlLinkMap(fakeSite)).resolves.toBeUndefined();
  });

  it("follows a www-prefixed redirect on the same domain and proceeds with the crawl", async () => {
    // isAllowedUrl strips a leading "www." so www.example.com must be accepted
    // for a site configured with domain "example.com".
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeRedirectResponse(301, "https://www.example.com/sitemap.xml"),
      )
      .mockResolvedValueOnce(makeResponse(200, LEAF_SITEMAP_XML))
      .mockResolvedValue(makeResponse(200, "<html><body></body></html>"));

    await expect(runCrawlLinkMap(fakeSite)).resolves.toBeUndefined();
  });

  it("throws when a redirect chain eventually escapes the allowed domain", async () => {
    // Hop 1: same-domain → allowed; Hop 2: off-domain → must throw.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeRedirectResponse(301, "https://example.com/sitemap-step2.xml"),
      )
      .mockResolvedValueOnce(
        makeRedirectResponse(301, "https://other-site.com/steal"),
      );

    await expect(runCrawlLinkMap(fakeSite)).rejects.toThrow("not allowed for domain");
  });
});
