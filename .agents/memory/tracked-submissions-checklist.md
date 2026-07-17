---
name: Tracked submissions checklist
description: The "My Submissions" page model and the cost rule for manually tracked URLs.
---

# Tracked submissions / "My Submissions"

The "My Submissions" page is a unified, day-grouped timeline that merges THREE
sources into one `SubmissionItem` list: Suggest Links lookups (`link_lookups`),
Optimizer queue items (`optimize_queue`), and user-curated tracked URLs
(`tracked_submissions`).

## Rule: tracked URLs are a manual checklist only — never process them

`tracked_submissions` is a plain CRUD checklist. Adding/listing/marking-done/
deleting a tracked URL must NEVER fetch the page, crawl, or call an AI model.

**Why:** The operator explicitly asked for a no-cost tracking list after
declining to run their URLs through Suggest Links or the Optimizer (both incur
paid HTTP fetch + Anthropic spend). Wiring tracked URLs into those pipelines
would silently reintroduce the cost they rejected.

**How to apply:** If asked to "process", "enrich", "score", or "auto-suggest"
for tracked URLs, confirm intent first — it crosses the cost boundary. Keep the
tracked-submissions route free of fetch/crawl/A/I calls.

## Keyword tracking / performance dialog (GSC-only exception)

Each tracked URL may carry one optional target `keyword`. The performance
endpoint (`GET /tracked-submissions/:id/performance`) is the ONLY processing
allowed for tracked URLs, and it calls the Google Search Console API
exclusively — still no page fetch, crawl, or AI.

- One GSC call per scope spans previous+current window (dimension=date, split
  locally at the window boundary) — halves quota use vs two calls.
- Page filter uses `includingRegex` built from the stored URL (escaped, with
  optional trailing slash and `[#?]` suffix) so #fragment/?query variants are
  summed (see gsc-anchor-fragments memory).
- Server-cached 30 min; endDate = today-2 (GSC lag).
- Query filter: GSC's `equals` operator is CASE-SENSITIVE while GSC stores
  queries lowercased — a keyword saved as "Ai visibility ..." matches nothing
  and keyword position silently falls back to zeros. Use `includingRegex` with
  `(?i)^<escaped, \s+ for whitespace runs>$` for exact-match semantics that
  tolerate capitalization/extra spaces from pasted sheets.
- Orval quirk: a route with BOTH path and query params emits a zod const and a
  TS type with the same `<Op>Params` name → TS2308 in the api-zod barrel. Fix
  with explicit re-exports (zod const keeps name, type gets an alias).

## Other durable choices

- Still-open tracked items (status `tracking`) are exempt from the page's
  day-window filter so the checklist never silently hides open items; everything
  else respects the selected window.
- POST is batch and accepts BOTH shapes: legacy `urls: string[]` + shared
  `keyword` (now a default), and `items: [{url, keyword?}]` for per-URL
  keywords. It UPSERTS by URL (case-insensitive `lower(url)` match): re-pasting
  a sheet updates keywords on existing rows instead of duplicating; a blank
  keyword never clears an existing one, and note is never updated on upsert.
- Enforces http(s)-only URLs (mirrors the `link-lookups` protocol check)
  because the UI renders each URL as a clickable `<a href>`.
- Bulk-add textarea parses each line as `URL<TAB>keyword` / `URL, keyword` /
  `URL keyword` (tab first, then comma, then whitespace) so users paste two
  spreadsheet columns directly.
- Performance dialog has a day-wise table (Date/Position/Impressions/Clicks)
  with day-over-day coloring: green uplift, red decline, NO color when
  unchanged (explicit user requirement); position compared at 1 decimal,
  lower is better.
