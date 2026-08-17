import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { classifyPlacement } from "./linkPlacement";

/**
 * Build a minimal cheerio tree for a link nested inside a wrapper element,
 * then return the link element so classifyPlacement can walk its ancestors.
 *
 * @param wrapperHtml  The outer HTML of the ancestor element, e.g.
 *                     `<aside class="sidebar"><a href="/x">link</a></aside>`
 */
function linkInside(wrapperHtml: string): {
  $: cheerio.CheerioAPI;
  el: unknown;
} {
  const $ = cheerio.load(wrapperHtml);
  const el = $("a").get(0)!;
  return { $, el };
}

// ---------------------------------------------------------------------------
// Sidebar / complementary: must be classified as "nav"
// ---------------------------------------------------------------------------

describe("classifyPlacement — sidebar containers return 'nav'", () => {
  it("<aside> element", () => {
    const { $, el } = linkInside('<aside><a href="/x">link</a></aside>');
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("role=\"complementary\"", () => {
    const { $, el } = linkInside(
      '<div role="complementary"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".sidebar class", () => {
    const { $, el } = linkInside(
      '<div class="sidebar"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".widget-area class (WordPress default sidebar)", () => {
    const { $, el } = linkInside(
      '<div class="widget-area"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".secondary-sidebar class", () => {
    const { $, el } = linkInside(
      '<div class="secondary-sidebar"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("sidebar- prefixed class", () => {
    const { $, el } = linkInside(
      '<div class="sidebar-1"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".widget class alone", () => {
    const { $, el } = linkInside(
      '<div class="widget"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".widgets class (plural)", () => {
    const { $, el } = linkInside(
      '<div class="widgets"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it(".widget-areas class (plural)", () => {
    const { $, el } = linkInside(
      '<div class="widget-areas"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("widget-area- prefixed class", () => {
    const { $, el } = linkInside(
      '<div class="widget-area-1"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("<aside> nested inside <main> still returns 'nav' (nearest wins)", () => {
    const { $, el } = linkInside(
      '<main><aside><a href="/x">link</a></aside></main>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("multiple mixed classes — sidebar token present among others", () => {
    const { $, el } = linkInside(
      '<div class="col-md-3 sidebar sticky"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("nav");
  });
});

// ---------------------------------------------------------------------------
// Sanity: genuine page-builder *-widget-* wrappers must NOT be classified as
// sidebar/nav (the token must be an exact class token, not a substring match).
// ---------------------------------------------------------------------------

describe("classifyPlacement — Elementor/page-builder widget wrappers do NOT trigger sidebar", () => {
  it("elementor-widget-text-editor falls through to 'content' inside <main>", () => {
    const { $, el } = linkInside(
      '<main><div class="elementor-widget-text-editor"><a href="/x">link</a></div></main>',
    );
    // 'elementor-widget-text-editor' must NOT match token 'widget' or 'widget-area'
    expect(classifyPlacement($, el)).toBe("content");
  });

  it("siteorigin-widget-wrap falls through to 'content' inside <article>", () => {
    const { $, el } = linkInside(
      '<article><div class="siteorigin-widget-wrap"><a href="/x">link</a></div></article>',
    );
    expect(classifyPlacement($, el)).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// Other placements are unaffected
// ---------------------------------------------------------------------------

describe("classifyPlacement — other structural zones still work", () => {
  it("<nav> returns 'nav'", () => {
    const { $, el } = linkInside('<nav><a href="/x">link</a></nav>');
    expect(classifyPlacement($, el)).toBe("nav");
  });

  it("<header> returns 'header'", () => {
    const { $, el } = linkInside('<header><a href="/x">link</a></header>');
    expect(classifyPlacement($, el)).toBe("header");
  });

  it("<footer> returns 'footer'", () => {
    const { $, el } = linkInside('<footer><a href="/x">link</a></footer>');
    expect(classifyPlacement($, el)).toBe("footer");
  });

  it("<article> returns 'content'", () => {
    const { $, el } = linkInside('<article><a href="/x">link</a></article>');
    expect(classifyPlacement($, el)).toBe("content");
  });

  it("<main> returns 'content'", () => {
    const { $, el } = linkInside('<main><a href="/x">link</a></main>');
    expect(classifyPlacement($, el)).toBe("content");
  });

  it("bare <div> with no recognised class defaults to 'content'", () => {
    const { $, el } = linkInside(
      '<div class="wrapper"><a href="/x">link</a></div>',
    );
    expect(classifyPlacement($, el)).toBe("content");
  });
});
