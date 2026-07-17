const CORE_PATTERNS: RegExp[] = [
  /\/pricing/i,
  /\/features/i,
  /\/product/i,
  /\/solutions/i,
  /\/geo\b/i,
  /\/aeo\b/i,
  /\/ai-visibility/i,
  /\/ai-citations/i,
  /\/chatgpt-/i,
  /\/perplexity-/i,
  /\/ai-overviews/i,
  /\/gemini-/i,
  /\/brand-visibility/i,
  /\/citation-/i,
];

export function sectionFor(url: string): "core" | "outer" {
  return CORE_PATTERNS.some((p) => p.test(url)) ? "core" : "outer";
}

// Hard cap on how many outbound internal-link suggestions the homepage may
// receive in a single engine run. The homepage is a curated entry point — it
// should link to a handful of high-value pages, never accumulate many links to
// random blog posts.
export const HOMEPAGE_MAX_OUTBOUND_SUGGESTIONS = 3;

/**
 * True when `url` is the site homepage (its root path, e.g. https://site.com/).
 * Detection is domain-agnostic: any URL whose path is empty/"/" is the homepage.
 * Used to special-case the homepage as a link DONOR so the suggestion engines
 * don't propose many homepage → random-blog outbound links.
 */
export function isHomepage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}
