---
name: Concurrency pools must allSettle
description: Worker-pool helpers awaited with Promise.all can crash the whole Node process on a second rejection.
---

A hand-rolled concurrency pool (N worker loops awaited with `Promise.all`) crashes the entire process on Node 24 when two workers reject: `Promise.all` rejects on the first, and the second rejection is never observed → unhandled rejection → exit.

**Why:** the keyword-sheet cron for a site without GSC threw in two workers at once and took down the whole API server on startup.

**How to apply:** in any mapWithConcurrency-style helper, `Promise.allSettled` the workers, then rethrow the first rejection. Also: per-site jobs should treat "integration not connected" as a logged skip, never a throw.

## Fire-early / await-late promises
Same crash class: a promise kicked off early (`const p = load(...)`) and awaited much later crashes the process if an intervening `await` throws first — `p`'s rejection is never observed. Attach `p.catch(() => {})` immediately at creation; the real error still propagates at the awaited use site. Hit this in the keyword-movement sheet export when GSC wasn't connected for a site.
