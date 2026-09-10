# Internal Link System

AI-assisted internal linking for a website: it reads your pages and proposes contextually relevant internal links, scored on meaning rather than keyword matches. Built by [Khadija Zaman](https://khadijazaman.com/) and used in the SEO programs described at [khadijazaman.com/tools](https://khadijazaman.com/tools/#open-source).

## What it does

- Crawls the pages of a site you own (with an SSRF guard) and chunks their content.
- Scores candidate source and target pairs with pure, unit-tested helpers, then batches the shortlist through the Claude API for contextual link proposals.
- Stores proposals per site, with multi-tenant ownership, so a team can review and export them.
- Connects Google Search Console, GA4 and Bing per site to weight proposals by pages that already earn traffic.

## Structure

pnpm workspace, Node 24, TypeScript 5.9.

- `artifacts/api-server/` — Express 5 API (auth, sites, integrations, admin overview)
- `artifacts/dashboard/` — React review dashboard
- `lib/api-spec/` — OpenAPI contract, the source of truth; `lib/api-zod/` and `lib/api-client-react/` are generated from it
- `lib/db/` — PostgreSQL schema with Drizzle ORM
- `lib/integrations-anthropic-ai/` — Claude batch integration
- `threat_model.md` — what the SSRF guard and tenancy checks defend against

## Run

```bash
pnpm install
pnpm --filter @workspace/db run push                 # dev only: push the schema
pnpm --filter @workspace/api-server run dev          # API on port 5000
pnpm run typecheck && pnpm run build
pnpm --filter @workspace/api-server run test         # vitest: scoring, chunking, SSRF guard
```

Required environment: `DATABASE_URL` (PostgreSQL), `CLERK_SECRET_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` (auth), and an Anthropic API key for the link proposals. Regenerate API hooks after editing the OpenAPI spec with `pnpm --filter @workspace/api-spec run codegen`.

## Licence

MIT. See `LICENSE`.
