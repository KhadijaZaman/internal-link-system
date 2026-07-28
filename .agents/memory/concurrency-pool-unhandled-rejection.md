---
name: Concurrency pools must allSettle
description: Worker-pool helpers awaited with Promise.all can crash the whole Node process on a second rejection.
---

A hand-rolled concurrency pool (N worker loops awaited with `Promise.all`) crashes the entire process on Node 24 when two workers reject: `Promise.all` rejects on the first, and the second rejection is never observed → unhandled rejection → exit.

**Why:** the keyword-sheet cron for a site without GSC threw in two workers at once and took down the whole API server on startup.

**How to apply:** in any mapWithConcurrency-style helper, `Promise.allSettled` the workers, then rethrow the first rejection. Also: per-site jobs should treat "integration not connected" as a logged skip, never a throw.
