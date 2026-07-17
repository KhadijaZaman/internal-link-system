---
name: Autoscale kills long background jobs
description: Why 30-100 min pipeline runs die silently on Autoscale and the heartbeat/interrupted/self-ping design that surfaces it.
---

**Rule:** On an Autoscale deployment, a long background job (the full pipeline runs 30–100+ min) only survives while HTTP traffic keeps the instance alive. Once the dashboard tab closes (polling stops), the instance is recycled and the job dies silently mid-step.

**Why:** Confirmed in production logs (July 2026): a full-pipeline run completed 6 of 8 steps, then a fresh "Cron schedules registered" boot line appeared ~8 min into `audit_broken_links` — no step-failed or pipeline-finished log. Because the `job_runs` row was only written in the job's `finally`, the UI kept showing the *previous* run's error, which looked like the old bug had returned (it hadn't — the retry fix visibly worked: `semantic_linking` hit "Authentication timed out", retried, succeeded).

**How to apply:**
- Job runner persists `lastStatus="running"` at start, heartbeats `lastRunAt` every 60s, and self-pings the public `/api/healthz` (only when `REPLIT_DEPLOYMENT` is set) to keep traffic flowing during jobs. Best-effort only.
- `loadJobStatuses` treats a DB "running" row with a stale (>3 min) heartbeat as `interrupted` (persisted, with explanatory error); a fresh heartbeat from another instance counts as still running.
- The guaranteed fix is switching the deployment to Reserved VM (always-on); Autoscale + self-ping is a mitigation, not a guarantee. User was informed of the tradeoff.
- Full-pipeline steps write per-step `job_runs` rows on completion, so a mid-run kill preserves progress of finished steps; re-running the pipeline is safe/idempotent.
