import type * as cheerio from "cheerio";

/**
 * Where on the page a link lives. "content" = inside article/main/body
 * content; anything else is structural chrome (nav/header/footer).
 *
 * Only `content` placement counts toward internal-linking decisions —
 * orphan detection, over-linked thresholds, the suggestion engine. The
 * other buckets are stored so the dashboard can show breakdowns like
 * "X body + Y chrome", but they're excluded from logic.
 *
 * Centralised here (rather than living in `crawlLinkMap.ts`) so both the
 * sitemap crawler and the WP sitemap-content crawler can share the same
 * classifier and avoid drifting apart.
 */
export type LinkPlacement = "content" | "nav" | "header" | "footer";

// cheerio v1 no longer re-exports htmlparser2 node types. We only need
// `.type`, `.name`, and `.parent`, plus the ability to pass the node to
// `$()`, so a minimal structural type avoids a hard dep on domhandler.
type AnyNodeLike = {
  type: string;
  name?: string;
  parent?: AnyNodeLike | null;
};

const PLACEMENT_RANK: Record<LinkPlacement, number> = {
  content: 0,
  nav: 1,
  header: 2,
  footer: 3,
};

export function placementRank(p: LinkPlacement): number {
  return PLACEMENT_RANK[p];
}

/**
 * Walk the link's ancestor chain (via cheerio) and classify it as content
 * vs nav/header/footer. We prefer the *nearest* structural ancestor — if a
 * <nav> sits inside a <header>, the link is "nav".
 *
 * Only links inside the editorial body count as "content". Navigation,
 * header, footer, AND sidebar/complementary links are all treated as
 * structural chrome and excluded from internal-linking decisions.
 *
 * Detection covers semantic HTML5 elements (<nav>, <header>, <footer>,
 * <aside>, <article>, <main>), ARIA roles (navigation, banner, contentinfo,
 * complementary, main), and common WP / theme class conventions (.menu,
 * .navbar, .site-header, .site-footer, .global-nav, .primary-menu,
 * .breadcrumbs, .sidebar, .widget, .widget-area, etc.). Anything we can't
 * confidently classify defaults to "content" so we never silently exclude a
 * real body link.
 */
export function classifyPlacement(
  $: cheerio.CheerioAPI,
  el: unknown,
): LinkPlacement {
  let cur: AnyNodeLike | null | undefined =
    (el as AnyNodeLike).parent ?? null;
  while (cur && cur.type === "tag") {
    const name = (cur.name ?? "").toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $cur = $(cur as any);
    const role = ($cur.attr("role") ?? "").toLowerCase();
    const cls = ($cur.attr("class") ?? "").toLowerCase();
    const id = ($cur.attr("id") ?? "").toLowerCase();
    const blob = `${cls} ${id}`;
    // Tokenise class/id so sidebar detection matches on exact class tokens,
    // not substrings. A `\bwidget\b` regex over the blob would also match
    // page-builder wrappers like `elementor-widget-text-editor` (hyphens are
    // regex word boundaries). Elementor/SiteOrigin wrap ALL body content in
    // such `*-widget-*` divs, so substring matching would wrongly bucket
    // every body link as chrome and zero out content links sitewide.
    const tokens = blob.split(/\s+/).filter(Boolean);
    // Sidebar / complementary widgets. WordPress sidebars are almost always
    // a semantic <aside>, carry a widget/sidebar class, or are marked
    // role="complementary". These are NOT body links, so they must not fall
    // through to the "content" default. Bucketed as chrome (excluded).
    if (
      name === "aside" ||
      role === "complementary" ||
      tokens.some(
        (t) =>
          t === "sidebar" ||
          t === "side-bar" ||
          t === "widget" ||
          t === "widgets" ||
          t === "widget-area" ||
          t === "widget-areas" ||
          t === "secondary-sidebar" ||
          t.startsWith("sidebar-") ||
          t.startsWith("widget-area"),
      )
    ) {
      return "nav";
    }
    if (
      name === "nav" ||
      role === "navigation" ||
      /\b(menu|navbar|navigation|primary-menu|main-menu|site-nav|global-nav|mega-menu|breadcrumb|breadcrumbs)\b/.test(
        blob,
      )
    ) {
      return "nav";
    }
    if (
      name === "header" ||
      role === "banner" ||
      /\b(site-header|page-header|masthead|topbar|top-bar)\b/.test(blob)
    ) {
      return "header";
    }
    if (
      name === "footer" ||
      role === "contentinfo" ||
      /\b(site-footer|page-footer|colophon)\b/.test(blob)
    ) {
      return "footer";
    }
    if (
      name === "article" ||
      name === "main" ||
      role === "main" ||
      /\b(post-content|entry-content|article-body|post-body|main-content|content-area)\b/.test(
        blob,
      )
    ) {
      return "content";
    }
    cur = cur.parent;
  }
  return "content";
}
