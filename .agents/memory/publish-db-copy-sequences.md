---
name: Publish-time DB copy leaves sequences behind
description: Replit "Create production database" copies rows but can leave serial sequences lagging max(id), breaking all INSERTs in prod.
---

# Publish DB copy can desync serial sequences

When publishing with "Create production database" (prod DB seeded as a copy of
dev), copied rows keep their IDs but owned serial sequences can be left behind
max(id). Every subsequent INSERT into an affected table then fails with a
duplicate-key violation on the primary key. Observed July 2026: audit_reports
seq at 39 vs max(id) 54; link_suggestions 54 vs 60 — broke the 3 pipeline audit
steps in prod.

**Why it must be fixed in app code:** agent SQL access to the production DB is
read-only (`setval` blocked), so the repair has to ship via deploy. The server
now runs a forward-only sequence resync at startup
(`artifacts/api-server/src/lib/sequenceResync.ts`) — data-level `setval` only,
no DDL, non-fatal, no-op on healthy DBs.

**How to apply:** if prod INSERTs fail with duplicate-key on a serial PK right
after a publish/DB-copy, check `pg_sequences.last_value` vs `max(id)` before
suspecting app logic. The startup resync should self-heal on the next deploy;
verify via the "Sequence resync" startup log lines.
