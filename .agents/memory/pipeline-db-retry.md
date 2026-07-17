---
name: Pipeline DB transient-retry on autoscale
description: Why the long full-pipeline run wraps DB ops in withDbRetry, and the idempotency-only rule for what may be wrapped.
---

# Long pipeline + serverless Postgres: retry transient connection drops

The "Run Full Pipeline" job runs end-to-end for hours (observed ~2.7h). On the
autoscale production deployment against serverless Postgres, individual queries
intermittently fail mid-run with transient connection/auth errors ("Connection
terminated unexpectedly", "Authentication timed out") even though the same query
type succeeds in later steps. This is expected infrastructure behavior for a
single multi-hour job, NOT a schema/query bug.

**Rule:** wrap pipeline DB operations in `withDbRetry`
(`artifacts/api-server/src/lib/dbRetry.ts`), which retries ONLY transient
connection/auth errors (message-substring + class-08 / 57Pxx SQLSTATE +
cause-chain) with bounded exponential backoff.

**Why idempotency-only:** a dropped ack after a committed write would duplicate
rows on retry. Only wrap SELECTs and upserts (`onConflictDo*`). A plain INSERT
may be wrapped ONLY when a rare duplicate row is explicitly harmless and that
reasoning is documented inline (e.g. `audit_reports` `record()` — the dashboard
reads only the newest report per type, so a duplicate is invisible). Otherwise
make the insert idempotent first if you need it retry-safe.

**How to apply:** any new long-running pipeline DB read/upsert should go through
`withDbRetry`. The actual crawl (`runCrawlLinkMap`) is NOT wrapped because it has
external side effects.

**Pattern list is a moving target:** the transient-error match list is
substring-based and serverless PG keeps producing new message variants. Observed
in prod (July 2026): "Client network socket disconnected before secure TLS
connection was established" escaped the retry and failed a wrapped step — added
"socket disconnected" + "socket hang up". If a wrapped step ever fails with a
connection-ish error, first check whether the message is simply missing from
`TRANSIENT_PATTERNS` before suspecting anything deeper.

**Bigger lever:** a multi-hour background job on an autoscale deployment is
fragile (instance recycling + connection drops). A reserved-VM or scheduled
deployment is the durable fix if transient failures persist.
