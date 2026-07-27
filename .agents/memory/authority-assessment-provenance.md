---
name: Authority one-pager provenance
description: Data-provenance decisions behind the Wellows topical-authority one-pager (artifacts/authority) and what must stay in sync on regeneration.
---

**Rule:** The public authority assessment is a frozen API-sourced snapshot. Any public data claim must print its source and its gaps on-page: GSC Search Analytics API (no BigQuery export exists for this property — probed 2026-07), Bing query-level unreported share, GA4 host/key-event attribution, junk-query filter, partial first/last months.

**Why:** Operator accepted API-sourced numbers as defensible for public claims *only* with the anonymized-query gap (~56% impressions) and Bing unreported share (~58%) disclosed; cluster totals deliberately cannot reconcile to site totals.

**How to apply:** The verdict/claims numerals in the assessment page JSX are intentionally baked from the frozen dataset. Regenerating `assessment.json` (pipeline scripts persisted in the artifact's `scripts/` dir) requires updating those JSX numerals in the same change, or they silently drift. Google and Bing metrics must never be summed or blended — side-by-side only.

## Content directives (user, 2026-07-27)
- **No signup/conversion data anywhere in the public report** — page, `src/data/assessment.json`, and the exported Google Doc. GA4 key-event counts (signups/demos) were removed as first-party data an outside reader cannot verify. Sessions/engagement stay. The JSON's `ga4` blocks intentionally carry no `conversions` field.
- **Trap:** `scripts/analyze.mjs` still emits `conversions` — any pipeline re-run reintroduces it. Strip it again (and keep `meta.sources.ga4` free of the key-events mention) before shipping a regenerated snapshot.
- **Verdict is prescriptive, not descriptive**: "Optimize for AI Visibility as the central entity; GEO stays the supporting commercial layer (out-clicks on Google); Bing counterpoint disclosed." Keep this framing on regeneration.
- **Download-copy trap:** `public/data/{unmatched_full,geo_flags_full,gaps_full}.json` must be the SCOPED /tmp exports (unmatched `{google,bing}` query arrays / geo flag lists / full 19-gap array) — a full-snapshot copy of assessment.json once shipped in all three and leaked the conversion fields into the public downloads. Raw query text containing "sign up" etc. is fine (it's public GSC data); the banned surface is GA4 key-event/conversion fields.
