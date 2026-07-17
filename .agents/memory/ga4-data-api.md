---
name: GA4 Data API (page engagement)
description: How to pull page-wise GA4 metrics for this project — no Replit connector exists, so use a service account against the GA4 Data API.
---

# GA4 Data API — page-wise engagement

There is **no Google Analytics / GA4 connector in Replit's catalog** (searched "google analytics", "GA4", "analytics" — only Amplitude/Datadog/etc., and Google Sheets/Calendar/Docs/Drive/Gmail/Play). So GA4 is wired the same way GSC is: directly against the API with credentials in secrets.

**Auth = service account.** Secrets:
- `GA4_SERVICE_ACCOUNT_JSON` — full service-account JSON key.
- `GA4_PROPERTY_ID` — the **numeric** property id (Admin → Property details), NOT the `G-XXXX` measurement id.
The service-account email must be added as a **Viewer** in GA4 Admin → Property Access Management.

**The 403 trap:** the Google Analytics **Data** API (`analyticsdata.googleapis.com`) must be enabled in the *same* Google Cloud project the service account lives in. The 403 message names that project by **number** (e.g. `...project 721063746886...`). A project's display name (e.g. "My First Project") is unrelated to its project id/number, so enabling the API in a different project is the usual cause of a persistent 403 even after the user thinks it's done. Direct enable link form: `https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=<NUMBER>`.

**Flow:** the shipped integration uses the `googleapis` `google.auth.JWT` helper (`{ email, key, scopes }` → `getAccessToken()`) to get a bearer token, then `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`. (You *can* hand-sign an RS256 JWT — `iss`=client_email, `scope`=`analytics.readonly`, `aud`=`https://oauth2.googleapis.com/token`, grant_type `urn:ietf:params:oauth:grant-type:jwt-bearer` — if you ever need a no-dep path, but the library helper is what's in the code.)

**Page engagement query:** `dimensions=[pagePath]`, `metrics=[engagementRate, sessions, engagedSessions, screenPageViews, userEngagementDuration]`. `engagementRate = engagedSessions/sessions`; avg engagement time/session = `userEngagementDuration/sessions` (seconds). `pagePath` excludes the query string. Normalize (lowercase, strip trailing slash) to match the sheet / `inventory` paths — aggregate any dup trailing-slash variants and recompute rate from summed engaged/sessions rather than averaging rates.

**Caveat to surface:** many individual pages have small 28d session counts, so per-page rates (100% on 13 sessions, 0% on 1) are noisy — always read engagement rate next to the Sessions column.
