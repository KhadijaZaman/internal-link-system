---
name: Prod→dev DB copy technique
description: How to bulk-copy production Postgres data to dev via the read-only replica, and the hard limits hit along the way.
---

Production DB is reachable only via `executeSql({environment:"production"})` (read-only replica, SELECT only). No prod connection string is available, so pg_dump is impossible. To copy prod → dev:

- **Read**: `SELECT encode(convert_to(COALESCE(json_agg(t),'[]')::text,'UTF8'),'base64') FROM (SELECT ... LIMIT n) t` — base64 makes output CSV-safe (no quote/newline parsing bugs). Keyset-paginate on the PK (`WHERE pk > last ORDER BY pk`), never OFFSET.
- **Write**: `INSERT INTO tbl SELECT * FROM jsonb_populate_recordset(NULL::tbl, $tag$<json>$tag$::jsonb) ON CONFLICT DO NOTHING` — handles type casts (timestamps, jsonb, arrays) without per-value escaping; missing keys become NULL.

**Hard limits (learned the hard way):**
- SQL statement is passed as a process arg: **~128KB max (E2BIG)**. Keep each statement's JSON under ~90KB; batch rows by byte size, not row count.
- Read outputs beyond ~1MB get the backend **killed by signal**. Keep chunks so base64 output stays well under that; for single rows >300KB, read column slices via `substr(col::text, i, 200000)` and reassemble.
- Rows bigger than 90KB: insert a stub with big fields NULL, then build the value in a `_sync_buf(k,buf text)` staging table with `buf = buf || $piece$` appends, finally `SET col = buf::<udt>`.
- ON CONFLICT DO NOTHING makes chunk retries idempotent — required because failures mid-chunk leave partial inserts.
- **Skip pgvector `embedding` columns** — 30KB/row, trivially regenerable; syncing them multiplies runtime ~5x.
- code_execution calls time out at 600s and the notebook can be wiped; keep per-call budgets ≤400s with deadline checks in every loop, persist resume state in DB-derivable form (max PK in dev).

**Why:** needed when the Publish flow demands deleting the old production DB (e.g. deployment-type switch); Replit seeds the new prod DB from dev, so dev must hold a full copy first. Big regenerable tables (gsc_snapshots, query_losers) can go to `.local/prod_backup/*.jsonl` files instead of dev inserts (2x faster).
