---
name: Multi-tenant auth gates
description: Lessons from converting single-admin auth to Clerk + per-site ownership — where authorization regressions hide and how to smoke-test them.
---

# Auth-swap authorization regressions

**Rule:** When swapping a single-admin password for self-service sign-up auth (Clerk etc.), "authenticated" silently changes meaning from "the operator" to "anyone on the internet who signed up". After the swap, audit every route that is auth-only (no ownership/tenant check) — especially spend-bearing surfaces (paid API calls, job triggers) and operator-data reads. A mechanical "add tenant scoping to all DB routes" sweep misses routes that don't touch the DB directly (proxy-to-external-API routes, job triggers) precisely because they had nothing to scope.

**Why:** In this project three such routes (job triggers, live GSC proxy, OpenAI content writer) passed typecheck, scoping sweep, and smoke tests, and were only caught by review — each would have let any stranger spend the operator's API budget or read their search data.

**How to apply:** After any auth-model change, grep for the auth middleware and list routes that mount it WITHOUT a tenant/ownership middleware; justify each one explicitly (health checks, session info) or gate it.

# Smoke tests must use the real route path

A 404 from a wrong URL looks like "protected" in a lazy smoke test (non-200) but proves nothing. Copy the exact path from the route registration (`/jobs/:jobName/run`, not `/jobs/run/:jobName`) and assert the specific status (401/403), not just "not 200".

# Legacy-data claim flow pattern (worked well)

One-time claim of pre-migration data by the first real account: old shared password, timing-safe hash compare, rate limit keyed `userId|ip`, single-claim enforced by conditional `UPDATE ... WHERE owner_user_id IS NULL ... RETURNING` (no read-then-write race). E2E test must use a WRONG password when the claim is still open, or the test account steals ownership from the real operator.
