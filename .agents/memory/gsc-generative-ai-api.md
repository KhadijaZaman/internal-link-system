---
name: GSC Generative AI data access
description: Whether Search Console exposes AI Overviews / AI Mode data programmatically, and how to re-check when Google's rollout advances.
---

# GSC Generative AI data — API status

**Rule (as of 2026-07):** Google's "Generative AI performance" reports (AI Overviews + AI Mode,
announced 2026-06-03) are **UI-only**, rolling out to a subset of properties, impressions-focused,
with a manual export button. The Search Analytics API exposes **no** generative-AI `type` value and
**no** AI-related `searchAppearance` enum — per-page Google-AI columns cannot be fed automatically.

**Why:** the operator asked for per-page "GSC Generative AI" columns in the keyword-movement sheet;
building them required verifying the data source exists. It doesn't (yet), so the sheet deliberately
has no Google-AI columns and the AI-citations columns remain Bing-Copilot-based.

**How to re-check (cheap, definitive):**
- Grouped query `dimensions:["searchAppearance"]` over a long range lists every appearance value the
  property has data for (wellows.com showed only `TRANSLATED_RESULT`).
- A filter with a candidate value 400s with `Expression X is not a valid 'searchAppearance' for type
  WEB` when the enum doesn't exist; a valid-but-empty value returns 200 with no rows — that
  distinction is the test. Candidate `type` values 400 with `Invalid value at 'type'`.
- Also check the Search Analytics API reference and the GSC changelog/blog for "generative" —
  rollout will likely reach the API/BigQuery bulk export eventually.

**BigQuery bulk export = 3rd surface, also negative (checked 2026-07-27):** the
`searchdata_url_impression` schema doc has no AI-related `is_*` appearance flags (no
is_ai_overview / is_ai_mode; "generative"/"AI" absent from the whole table reference). The is_*
booleans mirror the searchAppearance enum, so the API enum and export columns will likely flip
together — re-check both at once. The gen-AI help doc lists exactly one export path: the manual UI
button. 2026 SEO blogs claiming AI Overview impressions are isolatable via search appearance in BQ
are wrong per Google's own docs (AIO impressions fold into regular web totals).

**Wellows has NO bulk export configured:** the GA4 service account's GCP project
(booming-client-467306-i1) has BigQuery API enabled but zero datasets; the GSC OAuth token carries
only the `webmasters` scope; no BigQuery connection in Replit. If ever enabled: data accrues only
from setup day (no backfill), tables retained forever by default — enabling early is cheap
insurance, and a weekly INFORMATION_SCHEMA probe for new `is_ai%` columns is the natural watchdog.

**Probe gotcha:** webFetch markdown escapes underscores (`is\_amp…`) — de-escape before grepping
for snake_case identifiers, or schema greps come back falsely empty.

**Fallback path if the user wants it before API support:** the UI report's export file could be
uploaded like the existing Bing AI Performance report (same upload-parse-store pattern, new report
kind), feeding new sheet columns. Needs a sample export to see the format — and the property must
actually have the report (subset rollout).

**Decision (2026-07-27):** operator was offered the upload flow and chose to wait for API support
instead — don't re-pitch uploads; re-probe the API when Google-AI data comes up again. Same day:
offered enabling the BigQuery bulk export (as future-proofing) and declined — don't re-pitch that
either unless Google actually ships AI data on API/export.
