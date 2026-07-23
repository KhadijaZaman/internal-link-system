# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-server run test` — vitest unit tests (pure scoring/chunking helpers + SSRF guard)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string; `CLERK_SECRET_KEY` + `VITE_CLERK_PUBLISHABLE_KEY` — Clerk auth (Replit-managed); `ADMIN_PASSWORD` — now only used by the one-time legacy-site claim endpoint

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Auth: Clerk (Replit-managed) — `@clerk/express` on the API, `@clerk/clerk-react` on the dashboard
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/auth.ts` — Clerk session verification: `requireAuth` sets `req.userId` and lazily upserts the local `users` row
- `artifacts/api-server/src/lib/site.ts` — multi-tenancy core: `requireSite` (X-Site-Id header + ownership check → `req.site`, read via `getSite`/`getSiteId`), `requireLegacySiteOwner` (gates remaining legacy-bound surfaces: GSC bulk queries, content writer), `listSchedulableSites()` for the job scheduler, 30s in-memory site cache invalidated on claim
- `artifacts/api-server/src/routes/sites.ts` — `GET /api/sites` (user's sites) + `POST /api/sites/claim-legacy` (old admin password, timing-safe SHA-256 compare, rate-limited, single-claim via conditional UPDATE)
- `lib/db/src/schema/siteIntegrations.ts` + `artifacts/api-server/src/lib/siteIntegrations.ts` — per-site data-source credentials (`site_integrations` table: provider gsc/ga4/bing, credentials+config jsonb, unique(siteId,provider)); resolvers `getGscCreds`/`getGa4Creds`/`getBingApiKey(siteId)` prefer the per-site row and fall back to env vars ONLY for legacy site id 1; 30s cache invalidated on connect/disconnect
- `artifacts/api-server/src/routes/integrations.ts` — `/api/integrations` status + connect endpoints: GSC via shared Google OAuth app (GSC_CLIENT_ID/SECRET) with HMAC-signed state {siteId,userId,exp} (public callback, auto-matches property to site host), GA4 pasted service-account JSON (verified live before store), Bing pasted API key (verified live); credentials are never returned by any endpoint
- `artifacts/dashboard/src/pages/settings.tsx` — `/settings` Connections page (GSC connect/property picker, GA4/Bing forms); welcome.tsx has the add-site form (POST /sites → switchSite)
- `artifacts/dashboard/src/lib/site-context.tsx` — SiteProvider (localStorage active site, module-level `getActiveSiteId()` feeds the X-Site-Id header via the generated fetch client), SiteGate (welcome empty state / keyed remount on switch)
- `artifacts/api-server/src/lib/urlCanon.ts` — the single URL-hygiene module: canonical path/URL normalizer, url_blocklist matching, metric re-aggregation helpers
- `artifacts/api-server/src/services/pageCounts.ts` — the one shared "content pages" count + filter label used by Dashboard, Knowledge Graph, and Site Authority headers
- `artifacts/api-server/src/jobs/migrateUrlHygiene.ts` — idempotent retroactive migration (manual-only job `migrate_url_hygiene`)
- `artifacts/api-server/src/integrations/ga4.ts` — GA4 landing-page engagement (organic/all channel views), key events, AI-referral sessions; two runReports per range (host-filtered engagement + unfiltered key events)
- `artifacts/api-server/src/jobs/syncGa4Pages.ts` — weekly `sync_ga4_pages` job (Mon 03:30 UTC): 28d all-channel key events + AI sessions rolled onto `pages` (UPDATE-only, transactional reset+apply)
- `artifacts/api-server/src/lib/chunkText.ts` — pure, db-free KB chunking (paragraph-boundary splits + overlap); unit-tested
- `artifacts/api-server/src/jobs/embedKbChunks.ts` — background KB embedding drain loop (`embed_kb_chunks`): uploads store chunks with NULL embeddings, job embeds and derives doc status (pending/partial/ready) by counting embedded chunks vs `chunkCount`; triggered on upload + 10-min sweep cron
- `artifacts/api-server/src/lib/insights.ts` — pure, shared SEO insight primitives (unit-tested): CTR benchmark curve, underperformance/cannibalization rules, opportunity score, link-quality flags — single source of truth; read routes and the action queue must import from here, never re-declare
- `artifacts/api-server/src/jobs/auditLinkQuality.ts` — manual-only `audit_link_quality` job: re-scores every existing content link in `link_graph` with the same primitives as the suggestion engine (off_topic / tier_violation / generic_anchor), persisted on link_graph (`audit_*` cols); pure DB + math, no API spend
- `artifacts/api-server/src/lib/semanticScorer.ts` — pure scoring functions + `buildWhyLine()` (plain-English rationale computed at read time from stored sub-scores; null for legacy-v0 rows so the UI falls back to `korayRationale`)
- `artifacts/api-server/src/lib/kbGrounding.ts` — returns grounding `{text, passages}`; passages are persisted on `optimize_queue.grounding_passages` (jsonb) so the brief drawer can show "Knowledge-base sources used" (null = legacy brief, [] = generated ungrounded)
- `artifacts/api-server/src/services/keywordMovementSheet.ts` — persistent "Target Keyword Daily Movement" Google Sheet: spreadsheet id stored in `app_state` (key `keyword_movement_sheet_id`), every export/job run rewrites the SAME sheet in place (rename-old → add-new → delete-old in one batchUpdate); daily `sync_keyword_sheet` cron 06:00 UTC
- `artifacts/api-server/src/services/clustering.ts` — union-find SERP clustering + `isOperatorQuery()` junk filter (quoted/boolean/`site:` GSC scraper queries); filter runs at GSC selection (before paid SERP spend) and on rebuild; unit-tested
- `artifacts/api-server/src/integrations/openaiClusterLabels.ts` — gpt-4o-mini batch cluster naming (fail-soft to top-keyword fallback)
- `artifacts/api-server/src/jobs/keywordClustering.ts` — clustering job; `params.reprocess` triggers a free rebuild from stored SERP rows (transactional delete+insert; on failure previous clusters are kept and status restored)
- `artifacts/api-server/src/lib/louvain.ts` — shared Louvain community detection (used by Knowledge Graph and Similarity Explorer)
- `artifacts/api-server/src/integrations/bing.ts` — Bing Webmaster API client (GetPageStats/GetQueryStats for the rolling ~6-month window; API quirks: the URL lives in a field literally named `Query`, dates arrive as `/Date(ms±zzzz)/`, position `-1` means unknown → stored as null)
- `artifacts/api-server/src/jobs/syncBingPages.ts` — daily `sync_bing_pages` job (04:00 UTC + manual): fetch-before-txn, delete-all+reinsert into `bing_page_stats`/`bing_query_stats`, canonical-path merge, UPDATE-only `pages.bing*` rollups; also exports `applyAiCitationRollup(uploadId)` used by the upload route
- `artifacts/api-server/src/routes/bing.ts` — `GET /api/bing/pages` (GSC vs Bing vs AI-citations vs AI-sessions mapping report) + AI-citation CSV upload endpoints (header-tolerant kind detection: pages vs grounding_queries; Bing's AI Performance report has no API as of Jul 2026, so citations arrive by upload only)
- `artifacts/api-server/src/lib/csvParse.ts` — pure RFC-4180 CSV parser (quotes, BOM, CRLF); unit-tested
- `artifacts/api-server/src/integrations/claudeTopicalMap.ts` — two-phase Anthropic topical-map generation (phase 1: charter + 6 pillars; phase 2: per-pillar core_topic→supporting→subtopic expansion + bridges, fail-soft per pillar)
- `artifacts/api-server/src/jobs/generateTopicalMap.ts` — `generate_topical_map` job (manual-only): LLM phases → node persist (MAX_NODES cap) → 3-tier match vs existing pages (exact_slug, top_query, embedding ≥0.65) → stats; one active run enforced via 409 in route
- `artifacts/api-server/src/routes/topicalMap.ts` — 5 endpoints under `/api/topical-map` (runs list/detail, latest, POST generate, PATCH node status gap↔ignored only)
- `artifacts/dashboard/src/pages/topical-map.tsx` — `/topical-map` page: charter form, radial d3 tree on canvas (zoom/pan/click), coverage cards + per-pillar bars, node detail panel, gap list
- `artifacts/dashboard/src/components/data-narrative.tsx` — shared plain-English narrative block (DataNarrative + Num); callers compute the numbers client-side (bing.tsx aggregates rows with null-position exclusion; gsc/overview.tsx uses server totals/deltaPct). Every dashboard page carries HowThisWorks + InfoTip help (`@/components/how-this-works`, `@/components/info-tip`)
- `artifacts/api-server/src/routes/knowledgeGraph.ts` — graph nodes carry `loserSeverity` (worst severity from latest-week query_losers) + `openActions` (open action_items count) → "Issues & actions" color mode on `/knowledge-graph`
- `artifacts/api-server/src/routes/clustering.ts` — clusters carry `coreSimilarity`/`coreTag` (site centroid vs impression-weighted keyword-embedding mean, same 0.42 threshold as the authority snapshot; needs ≥min(3, kwCount) embedded keywords else null); cached 30 min per run. Cluster page bridges: per own-URL "Optimize" (adds to optimize queue) + "Links" (deep-link to `/link-map?url=`)
- `artifacts/api-server/src/jobs/analyzeSimilarity.ts` — Content Similarity Explorer job (`analyze_similarity`, manual-only): fetches pasted URLs via SSRF-guarded `fetchPageInHouse`, embeds + gpt-4o-mini topics/theme per article (fail-soft per URL), pairwise cosine (≥0.35 display, top-10), Louvain clusters on ≥0.45 edges; UI at `/similarity`, routes in `routes/similarity.ts`

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `requireAuth` means "any self-registered Clerk user", NOT "the operator" — every new data route must also mount `requireSite` (and filter every query by `eq(table.siteId, site.id)`); remaining legacy-bound surfaces (GSC bulk queries, content writer) must use `requireLegacySiteOwner`
- All `withCache` keys on site-scoped routes must be prefixed `s${site.id}|` or responses leak across tenants
- Background jobs are per-site: every job fn takes `site: SiteContext` as its first param; crons iterate owned sites sequentially via `runJobForAllSites` (scheduler.ts); the running-lock and `job_runs` rows are keyed `name:siteId`. Never call `getLegacySite()` in job code — it only remains for legacy integration edge cases
- Spend-bearing jobs must gate paid work through `lib/jobBudget.ts` (`budgetForSite(site)` → `take("llmCalls" | "serpQueries" | "crawlPages")`); per-site caps live on the sites table (maxCrawlPages/maxLlmCallsPerRun/maxSerpQueriesPerRun). When a cap trims a crawl set, skip reconcile-deletes (a truncated set would mass-delete inventory)
- Manual job triggers (`POST /api/jobs/:name/run`) are `requireSite` (any site owner), no longer `requireLegacySiteOwner`; job status is per-site via `loadJobStatuses(siteId)`
- `job_runs` is keyed `(name, site_id)` — every runner/pipeline read+write must include the job's `site.id` in values, `where`, and `onConflict` targets, or upserts hit the wrong composite key
- Raw `fetch` calls in the dashboard (outside generated hooks) must manually attach the `x-site-id` header via `getActiveSiteId()` (see ask.tsx SSE stream, bulk-queries.tsx)
- Every ingestion path (GSC, GA4, crawler, WordPress sync) and every live read that joins on URL/path MUST go through `urlCanon.ts` (`canonicalPath` + blocklist) — never store or compare raw URLs
- When rows collapse onto one canonical path, metrics must be MERGED (sum clicks/impressions, impression-weighted position), never overwritten
- Any change to a cached response shape must bump that cache key in lockstep (e.g. `report:pages:v5`, `ga4:pages:v4`, `authority-snapshot:v2`)
- GA4 key-event metrics fire on the app/Calendly hosts, NOT the marketing host — never put a `hostName` filter on a runReport that requests `keyEvents:*` metrics (it silently returns 0); fetch them unfiltered and join by landing-page path
- Requeued cluster-run rebuilds keep their original `createdAt` — any queued-staleness check must prefer `heartbeatAt` (set to now on requeue) or rebuilds get instantly marked interrupted
- `GET /api/similarity/runs` (list) deliberately returns `results: null` — it's polled every 3s during a run; clients must fetch `/api/similarity/runs/:id` for the full results payload
- When merging metric rows with nullable positions (Bing returns -1/unknown), exclude null-position rows from the impression-weighted average — mapping null→0 dilutes the average toward a falsely "better" rank
- The AI-citation upload route has a path-scoped `express.json({limit:"2mb"})` in app.ts (must stay registered before the global parser); the contract caps content at 1.5M chars
- Topical-map coverage matching uses a 0.65 embedding threshold, NOT the 0.42 on/off-core split — "this page already covers this topic" is a much stronger claim; at 0.5 nearly every topic false-matched and the gap analysis collapsed
- `queryGsc`/`queryGscDimension`/`listSitemaps`/`inspectUrl`/`gscSiteUrl` all require an explicit `siteId` (gscSiteUrl is async now) — new call sites must thread the site through; integration creds come from `lib/siteIntegrations.ts`, never read GSC/GA4/Bing env vars directly
- Topical-map nodes with status `published` are locked in the PATCH endpoint (only gap↔ignored) — false-positive published nodes can't be demoted by the operator yet (known follow-up)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
