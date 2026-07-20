---
name: Crawl reconcile guard
description: Destructive reconciles in crawl jobs must be guarded against partial source fetches; how the site-health score can crash from a data artifact.
---

# Crawl reconcile guard

**Rule:** Any job that reconciles the DB against a freshly fetched external inventory (sitemap, API listing) and deletes rows not in the fetched set MUST (a) propagate child-fetch failures instead of swallowing them (`.catch(() => [])` is banned in sitemap discovery), and (b) abort before any writes if the fetched set is <80% of the existing inventory (guard skipped when existing < 20 rows; `CRAWL_ALLOW_SHRINK=1` env override accepts a genuine shrink).

**Why:** One night a child sitemap (post-sitemap.xml, ~350 URLs) failed to load; the error was silently swallowed, the content crawl proceeded with 74 of ~427 pages, and its reconcile step mass-deleted the missing posts, their embeddings, and most of the link graph in production. Orphans/dead-ends exploded and the site-health score crashed ~40 points overnight — a data artifact, not a real SEO decline.

**How to apply:** When debugging a sudden site-health drop, first check `health_snapshots.components` (raw counts per component per day) to find which component spiked, then check whether `wp_posts` / `link_graph` row counts and `crawled_at` dates collapsed on the same day — that pattern means a bad crawl, not a real site problem. Recovery = one successful full crawl (posts re-upsert, graph rebuilds, embeddings regenerate; `page_classifications` survive deletion so classification costs are not re-incurred).

**Diagnostic bonus:** ranking-drop penalty (weight 25) saturates at 20 loser pages, so with thousands of critical/high losers it contributes a constant max deduction — it explains a low score but never explains a *change*.
