# Assessment data pipeline

These scripts produced `src/data/assessment.json` and `public/data/*.json` (frozen range **2026-01-27 → 2026-07-26**, Google finalized data through 2026-07-24). The page is a static snapshot — it has no backend and never refetches.

## Sources
- **Google**: GSC Search Analytics API (`searchanalytics.query`), property `https://wellows.com/` (URL-prefix, non-www), type=web. BigQuery bulk export is not configured for this property, so the API is the source; anonymized-query gap is disclosed on the page.
- **Bing**: Bing Webmaster Tools API (query- and page-level stats; page-level impressions without query attribution are disclosed as unreported share).
- **GA4**: GA4 Data API via service account — sessions by landingPage + sessionSource, key events `signup_success` + `invitee_meeting_scheduled`, host `wellows.com`.

## Run order
1. `bqProbe.mjs` — confirmed no GSC BigQuery export exists (probe only).
2. `gscPull.mjs` — Google query/page pulls (monthly + totals, junk-filtered later).
3. `gscBingBaseline.mjs`, `bingFanout.mjs`, `bingRetry.mjs` — Bing query/page/weekly pulls.
4. `ga4Pull.mjs` — GA4 sessions/engagement/conversions per engine.
5. `analyze.mjs` — the matching ruleset (Entity A: AI Visibility, Entity B: GEO), junk filter, intent rubric, gap computation; emits `assessment.json` + full audit files.

Raw intermediate pulls lived in `/tmp/authority/` (ephemeral, not committed). Scripts read credentials from environment secrets (`GSC_*`, `BING_WEBMASTER_API_KEY`, GA4 service account) — they are kept here for **auditability of the ruleset and methodology**; re-running them regenerates a *new* snapshot, which then requires updating the verdict/claims numerals baked into `src/pages/Assessment.tsx`.
