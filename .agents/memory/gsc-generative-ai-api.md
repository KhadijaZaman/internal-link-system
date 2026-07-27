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

**Fallback path if the user wants it before API support:** the UI report's export file could be
uploaded like the existing Bing AI Performance report (same upload-parse-store pattern, new report
kind), feeding new sheet columns. Needs a sample export to see the format — and the property must
actually have the report (subset rollout).
