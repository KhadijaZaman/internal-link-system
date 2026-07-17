# Threat Model

## Project Overview

Wellows is a single-admin internal SEO operations dashboard with a React frontend and an Express 5 API backed by PostgreSQL. It ingests Search Console data, crawls a configured site, generates internal-link suggestions and optimization briefs with Anthropic, and lets an authenticated operator review results and trigger background jobs.

## Assets

- **Admin session and admin password** — the app currently protects the entire dashboard with one shared administrator password and a signed session cookie. Compromise gives full access to the operational dashboard and all job triggers.
- **SEO and search analytics data** — inventory, link graph, loser reports, and optimization notes reveal site strategy and performance details that should stay restricted to the operator.
- **Third-party credentials and spend-bearing integrations** — Anthropic API access, Google Search Console OAuth credentials, DataForSEO credentials, `DATABASE_URL`, and `SESSION_SECRET` can all be abused for data access, cost generation, or broader compromise.
- **Background job execution capability** — scheduled and manually triggered jobs can crawl sites, query external APIs, and write data back to the database. Abuse can cause outbound requests, cost, or persistent bad data.

## Trust Boundaries

- **Browser to API** — every dashboard action crosses from an untrusted client to the Express API. The server must authenticate and authorize all non-public endpoints.
- **API to PostgreSQL** — the API can read and write all operational data. Injection or broken authorization at the API layer would expose the whole dataset.
- **API to external services** — the server talks to Google Search Console, Anthropic, DataForSEO, configured sitemap URLs, and crawled pages. User-controlled or weakly validated outbound requests are high-risk.
- **Unauthenticated to authenticated admin surface** — `/api/healthz`, `/api/auth/login`, `/api/auth/logout`, and `/api/auth/me` are public-facing entry points; the rest of the API is intended to require a valid admin session.
- **Production to dev-only surface** — `artifacts/mockup-sandbox` is treated as development-only and should be ignored unless a production serving path is introduced.

## Scan Anchors

- Production API entry points: `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/`.
- Highest-risk code areas: `artifacts/api-server/src/lib/auth.ts`, `artifacts/api-server/src/routes/auth.ts`, `artifacts/api-server/src/routes/optimize.ts`, `artifacts/api-server/src/jobs/optimizeUrls.ts`, `artifacts/api-server/src/routes/content.ts`, `artifacts/api-server/src/services/linkLookups.ts`, `artifacts/api-server/src/integrations/htmlFetch.ts`, `artifacts/api-server/src/jobs/`, `artifacts/api-server/src/integrations/`.
- Public surface: `/api/healthz`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`.
- Authenticated/admin surface: dashboard data routes, suggestion actions, optimize queue, loser actions, and manual job triggers.
- Usually ignore unless production reachability is proven: `artifacts/mockup-sandbox/**`.

## Threat Categories

### Spoofing

The application relies on a custom HMAC-signed session cookie and a single administrator password from environment variables. The system must ensure the login endpoint resists online password guessing, the session secret remains server-only, session cookies cannot be forged, and every protected route enforces `requireAuth` server-side.

### Tampering

The client can trigger queue mutations, suggestion state changes, loser-to-optimizer actions, and manual job runs. The API must treat all client input as untrusted, validate request bodies and parameters, and prevent attacker-controlled input from changing job behavior beyond the intended scope.

### Information Disclosure

The dashboard exposes SEO performance data, link maps, job errors, and integration-derived content. These responses must stay scoped to authenticated administrators, and logs and error handling must avoid leaking cookies, authorization headers, secrets, or full stack traces to unauthorized users.

### Denial of Service

Login, manual job triggers, and server-side crawls can all be abused to consume CPU, external API quota, and paid model usage. The application must enforce practical controls so unauthenticated or low-effort attackers cannot brute-force the admin password or trigger unbounded expensive work.

### Elevation of Privilege

Any weakness that turns public access into authenticated admin access is critical because there is effectively one role with broad powers. The system must prevent brute-force login, session forgery, broken route protection, and attacker-controlled server-side fetches that could pivot from dashboard access into internal network or cloud metadata access. That guarantee applies not only to crawler code but also to operator-triggered utility and optimization paths that accept URLs and later fetch them on the server.
