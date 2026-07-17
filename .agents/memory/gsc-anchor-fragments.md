---
name: GSC anchor-fragment URLs & non-www property
description: Why GSC page-level aggregation is wrong unless #anchor/?query fragment URLs are summed; the property is non-www.
---

# GSC anchor-fragment URLs inflate page counts / deflate naive rollups

Google Search Console (the wellows.com property) treats every **anchor-fragment
URL** (`https://wellows.com/blog/startup-ideas/#service-e-commerce-startup-ideas`)
and query-string variant as a **separate "page"** in the `page` dimension.
Long-form blog articles have dozens of these; short/`/tools/` pages usually have none.

**The property is NON-www: `https://wellows.com/...`.** Filtering `page equals
https://www.wellows.com/...` returns ~0 — a silent, total miss. Site pages are
referenced elsewhere as `www.wellows.com/...`, so normalize to path before matching.

## Two failure modes (both seen in a real supplied CSV, and reproduced by naive code)

1. **Page-level metrics collapsed by overwrite** → if you `normPath()` the page
   URL and `map.set()` without summing, each fragment overwrites the canonical
   row and you land on an arbitrary tiny fragment value. Result: impressions
   understated 50–200× (startup-ideas showed 2,362 vs real ~684k), clicks read 0,
   and Avg Position looks *too good* (reflects one anchor's query, not the page).
2. **Query data duplicated / count inflated** → the same query appears once per
   fragment URL, so distinct-query counts roughly double and "top queries" repeat.

**Why:** GSC never merges fragments for you; the `page` dimension is literal URLs.

**How to apply — correct page rollup:**
- Page-level impr/clicks: pull `dimensions:['page']` (bulk), then **SUM** by
  normalized path; position = impression-weighted `Σ(pos·impr)/Σimpr`.
- Distinct query count + deduped top queries: per-page `dimensions:['query']`
  with a page filter `operator:'includingRegex', expression:'^'+esc(canonicalUrl)+'([#?].*)?$'`
  so GSC aggregates canonical + fragments and returns one row per query.
- Canonical-only (`page equals .../slug/`) EXCLUDES fragments — it's a valid
  "bare page" number but lower than the true page total.
