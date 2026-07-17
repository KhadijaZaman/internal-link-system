---
name: First-fold CTA detection
description: Heuristic for detecting a page's above-the-fold CTA and where it lands, from server HTML.
---

# Detecting the first-fold CTA from raw HTML (cheerio)

Naive "first `<a>`/`<button>` in header/hero" detection is wrong — it picks nav dropdown toggles (e.g. a "Solutions" `<button>`) and author "Read Full Bio" links.

**Rules that matter:**
- Skip menu toggles: elements with `aria-haspopup` or `aria-expanded`.
- Skip author/bio links: href matching `/author/`.
- Do NOT treat every `<button>` as a CTA. Score candidates instead: strong CTA copy (`free trial`, `get started`, `book a demo`, `sign up`…) +5, strong destination (`//app.`, `/signup`, `/auth`, `/demo`, `/book`, calendly…) +4, `btn`/`cta` class +2; penalize nav-category labels (`Solutions|Products|Resources|Pricing|Blog|About`…) heavily. Require score ≥ 2.
- Pick the highest-scoring candidate across the header + hero zones; give hero a small tie-break bonus so a page-specific hero CTA wins over the global header CTA. Tag which zone won (Hero vs Header) — it tells you whether a page has its own CTA or only inherits the site-wide header one.
- Resolve landing: same-host → `pathname+search`; external → absolute URL; keep `mailto:`/`tel:`; drop `#`/`javascript:`. Strip tracking params (`_ga*`, `distinct_id`, `gclid`, `fbclid`) for a readable destination.

**Why:** marketing sites share one header CTA across all pages, and hero/article regions are full of non-CTA buttons; scoring + zone tagging separates the signal.
