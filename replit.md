# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-server run test` — vitest unit tests (pure scoring/chunking helpers + SSRF guard)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/urlCanon.ts` — the single URL-hygiene module: canonical path/URL normalizer, url_blocklist matching, metric re-aggregation helpers
- `artifacts/api-server/src/services/pageCounts.ts` — the one shared "content pages" count + filter label used by Dashboard, Knowledge Graph, and Site Authority headers
- `artifacts/api-server/src/jobs/migrateUrlHygiene.ts` — idempotent retroactive migration (manual-only job `migrate_url_hygiene`)
- `artifacts/api-server/src/integrations/ga4.ts` — GA4 landing-page engagement (organic/all channel views), key events, AI-referral sessions; two runReports per range (host-filtered engagement + unfiltered key events)
- `artifacts/api-server/src/jobs/syncGa4Pages.ts` — weekly `sync_ga4_pages` job (Mon 03:30 UTC): 28d all-channel key events + AI sessions rolled onto `pages` (UPDATE-only, transactional reset+apply)
- `artifacts/api-server/src/lib/chunkText.ts` — pure, db-free KB chunking (paragraph-boundary splits + overlap); unit-tested
- `artifacts/api-server/src/jobs/embedKbChunks.ts` — background KB embedding drain loop (`embed_kb_chunks`): uploads store chunks with NULL embeddings, job embeds and derives doc status (pending/partial/ready) by counting embedded chunks vs `chunkCount`; triggered on upload + 10-min sweep cron
- `artifacts/api-server/src/lib/semanticScorer.ts` — pure scoring functions + `buildWhyLine()` (plain-English rationale computed at read time from stored sub-scores; null for legacy-v0 rows so the UI falls back to `korayRationale`)
- `artifacts/api-server/src/lib/kbGrounding.ts` — returns grounding `{text, passages}`; passages are persisted on `optimize_queue.grounding_passages` (jsonb) so the brief drawer can show "Knowledge-base sources used" (null = legacy brief, [] = generated ungrounded)
- `artifacts/api-server/src/services/keywordMovementSheet.ts` — persistent "Target Keyword Daily Movement" Google Sheet: spreadsheet id stored in `app_state` (key `keyword_movement_sheet_id`), every export/job run rewrites the SAME sheet in place (rename-old → add-new → delete-old in one batchUpdate); daily `sync_keyword_sheet` cron 06:00 UTC
- `artifacts/api-server/src/services/clustering.ts` — union-find SERP clustering + `isOperatorQuery()` junk filter (quoted/boolean/`site:` GSC scraper queries); filter runs at GSC selection (before paid SERP spend) and on rebuild; unit-tested
- `artifacts/api-server/src/integrations/openaiClusterLabels.ts` — gpt-4o-mini batch cluster naming (fail-soft to top-keyword fallback)
- `artifacts/api-server/src/jobs/keywordClustering.ts` — clustering job; `params.reprocess` triggers a free rebuild from stored SERP rows (transactional delete+insert; on failure previous clusters are kept and status restored)
- `artifacts/api-server/src/lib/louvain.ts` — shared Louvain community detection (used by Knowledge Graph and Similarity Explorer)
- `artifacts/api-server/src/jobs/analyzeSimilarity.ts` — Content Similarity Explorer job (`analyze_similarity`, manual-only): fetches pasted URLs via SSRF-guarded `fetchPageInHouse`, embeds + gpt-4o-mini topics/theme per article (fail-soft per URL), pairwise cosine (≥0.35 display, top-10), Louvain clusters on ≥0.45 edges; UI at `/similarity`, routes in `routes/similarity.ts`

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Every ingestion path (GSC, GA4, crawler, WordPress sync) and every live read that joins on URL/path MUST go through `urlCanon.ts` (`canonicalPath` + blocklist) — never store or compare raw URLs
- When rows collapse onto one canonical path, metrics must be MERGED (sum clicks/impressions, impression-weighted position), never overwritten
- Any change to a cached response shape must bump that cache key in lockstep (e.g. `report:pages:v5`, `ga4:pages:v4`, `authority-snapshot:v2`)
- GA4 key-event metrics fire on the app/Calendly hosts, NOT the marketing host — never put a `hostName` filter on a runReport that requests `keyEvents:*` metrics (it silently returns 0); fetch them unfiltered and join by landing-page path
- Requeued cluster-run rebuilds keep their original `createdAt` — any queued-staleness check must prefer `heartbeatAt` (set to now on requeue) or rebuilds get instantly marked interrupted
- `GET /api/similarity/runs` (list) deliberately returns `results: null` — it's polled every 3s during a run; clients must fetch `/api/similarity/runs/:id` for the full results payload

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
