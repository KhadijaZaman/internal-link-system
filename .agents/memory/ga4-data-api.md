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

**The 403 trap:** the Google Analytics **Data** API (`analyticsdata.googleapis.com`) must be enabled in the *same* Google Cloud project the service account lives in. The 403 message names that project by **number**. A project's display name (e.g. "My First Project") is unrelated to its project id/number, so enabling the API in a different project is the usual cause of a persistent 403 even after the user thinks it's done. Direct enable link form: `https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=<NUMBER>`.

**Flow:** the shipped integration uses the `googleapis` `google.auth.JWT` helper (`{ email, key, scopes }` → `getAccessToken()`) to get a bearer token, then `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`. (You *can* hand-sign an RS256 JWT — `iss`=client_email, `scope`=`analytics.readonly`, `aud`=`https://oauth2.googleapis.com/token`, grant_type `urn:ietf:params:oauth:grant-type:jwt-bearer` — if you ever need a no-dep path, but the library helper is what's in the code.)

**Page engagement query (current design, 2026-07):** session-scoped `landingPage` dimension (NOT `pagePath`) + `sessionDefaultChannelGroup` + `sessionSource`, metrics `sessions/engagedSessions/userEngagementDuration`, with a `hostName` EXACT filter locking to the marketing host (the property also receives app/staging hits whose paths would pollute page metrics). Derive `engagementRate = engagedSessions/sessions` and avg time = `userEngagementDuration/sessions` from summed components — never average rates. Run paths through the canonical normalizer and re-aggregate.

**Key events need a SECOND, unfiltered report.** Key-event metrics (`keyEvents:<event_name>`) fire on other hosts (the app subdomain, calendly.com), so the `hostName` filter silently zeroes them even when the session landed on a marketing page. Fetch key events in a separate runReport with `landingPage` (+ channel group) and NO host filter, then merge only onto paths already present in the host-filtered report. `landingPage` strips the hostname, so this join is what excludes direct app/staging landings — it works because app paths (/auth/*, /overview/*, etc.) don't exist on the marketing site; a same-path collision would leak through (GA4 has no session-scoped landing-hostname dimension).

**AI-referral sessions:** the property's default channel group has an "AI Assistant" channel, but some AI referrals still land under "Referral"/"Unassigned" — match channel group OR a source regex (chatgpt|chat.openai|perplexity|gemini.google|copilot|claude). Count them across ALL channels regardless of the organic/all view.

**Caveat to surface:** many individual pages have small 28d session counts, so per-page rates (100% on 13 sessions, 0% on 1) are noisy — always read engagement rate next to the Sessions column.
