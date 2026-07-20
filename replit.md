# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
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

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Every ingestion path (GSC, GA4, crawler, WordPress sync) and every live read that joins on URL/path MUST go through `urlCanon.ts` (`canonicalPath` + blocklist) — never store or compare raw URLs
- When rows collapse onto one canonical path, metrics must be MERGED (sum clicks/impressions, impression-weighted position), never overwritten
- Any change to a cached response shape must bump that cache key in lockstep (e.g. `report:pages:v3`, `authority-snapshot:v2`)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
