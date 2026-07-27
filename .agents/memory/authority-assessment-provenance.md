---
name: Authority one-pager provenance
description: Data-provenance decisions behind the Wellows topical-authority one-pager (artifacts/authority) and what must stay in sync on regeneration.
---

**Rule:** The public authority assessment is a frozen API-sourced snapshot. Any public data claim must print its source and its gaps on-page: GSC Search Analytics API (no BigQuery export exists for this property — probed 2026-07), Bing query-level unreported share, GA4 host/key-event attribution, junk-query filter, partial first/last months.

**Why:** Operator accepted API-sourced numbers as defensible for public claims *only* with the anonymized-query gap (~56% impressions) and Bing unreported share (~58%) disclosed; cluster totals deliberately cannot reconcile to site totals.

**How to apply:** The verdict/claims numerals in the assessment page JSX are intentionally baked from the frozen dataset. Regenerating `assessment.json` (pipeline scripts persisted in the artifact's `scripts/` dir) requires updating those JSX numerals in the same change, or they silently drift. Google and Bing metrics must never be summed or blended — side-by-side only.
