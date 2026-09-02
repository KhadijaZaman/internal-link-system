---
name: Shared external-sheet refresh locking
description: Safety rule for multi-tenant services that update persistent external spreadsheets through one shared connector.
---

Bind each external workbook to exactly one tenant with a durable, transactionally serialized claim. Hold a database-backed lock for the complete sheet read-to-write refresh sequence; process-local job locks or in-memory maps are only an optimization.

**Why:** A shared connector can access multiple tenants' workbooks, and autoscaled instances can run cron, catch-up, and manual refreshes simultaneously. A preflight ownership lookup alone has a claim race, while a short binding lock still allows two processes to read stale sheet state and overwrite each other's updates.

For governed round-trip review sheets, export stable record IDs plus optimistic versions. Import only explicitly editable columns, reject cross-tenant and stale rows, and leave unchanged rows untouched so repeated imports are idempotent. The application database remains the source of truth.

**Why:** A spreadsheet is an asynchronous review surface. Without row versions and an editable-field allowlist, stale copies can overwrite fresher source evidence or turn presentation columns into a second task system.

**How to apply:** Use this rule whenever a persistent external document is refreshed in place. Validate it read-only, claim it before the first write, reject cross-tenant reuse and silent rebinding, serialize the entire refresh across processes, and batch related value changes atomically where the provider supports it.