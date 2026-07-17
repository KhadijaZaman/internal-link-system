---
name: SEO activity, link placement & re-crawl idempotency
description: Non-obvious rules for "published"/"optimized" activity, what link_graph counts, sidebar exclusion, and the re-crawl staleness trap.
---

# What counts as "published" vs "optimized"

- **Published** = a `wp_posts` row with a non-null `publish_date`.
- **Optimized** = an `optimize_queue` row with `status = "done"` (timestamp `completed_at`).
  - **Trap:** `status = "skipped_no_gsc"` ALSO stamps `completed_at` but is NOT an optimization. Filter on `status = "done"`, never on `completed_at` alone.

# What link_graph counts as an internal link

- Edges are **same-domain only** — the crawler rejects off-host targets before insert, so the table never holds external links.
- `placement` is a free-text column (no DB enum) with buckets content/nav/header/footer. **Only `placement = "content"` (editorial body) counts** anywhere; every consumer keys off `=== "content"`, so any other value is auto-excluded.
- "Body links" must exclude nav, header, footer **AND sidebar/complementary**. Sidebars are bucketed as chrome (currently reused the "nav" value to avoid a migration — fine because only "content" is ever counted).

# Sidebar classification (classifyPlacement)

- Detect sidebars by **exact class TOKENS** (split class/id on whitespace), never a `\b` substring regex. `\bwidget\b` over the class blob also matches page-builder wrappers like `elementor-widget-*` / `so-widget-*` that wrap ALL body content — that would bucket every body link as chrome and zero out content sitewide.
- Also treat the semantic `<aside>` element and `role="complementary"` as sidebar.

# Re-crawl idempotency trap (high value)

- A classifier / link-extraction change does **NOT** rewrite existing edges on its own. Each crawler must clear a source page's edges before reinserting; an upsert that ignores conflicts silently keeps the OLD placement (stale "content"). Every crawl path must delete-per-source, not rely on conflict-ignoring inserts.
- Recomputing stats must also **zero out** counts for pages that no longer have any content edge, or reclassified pages keep stale inbound/outbound numbers across the dashboard, backlink, and orphan views.
- **How to apply:** to push any extraction/classification change onto existing data, re-run the full pipeline (the `run_full_pipeline` job) — it rebuilds edges and recomputes stats. Afterward, sanity-check the content-vs-chrome distribution and confirm no page shows counts without a content edge before trusting the numbers.

# Link-count source of truth (one definition)

- Internal-link / internal-backlink counts have **one** canonical source: the link_stats edge counts (COUNT(*) of content edges), which is what the Link Map focus seed chips display. Any other surface that shows link counts (e.g. the daily-alerts breakdown drawer) must read from link_stats, **not** recompute its own distinct-neighbor grouping, or the surfaces silently drift apart.
- **Why:** a source page can link to the same target with multiple anchors, so an edge count and a distinct-neighbor count diverge once such duplicates exist. Picking one shared definition keeps every view consistent and lets you cross-check counts between surfaces.

# Anchor text in link_graph

- `anchor_text` holds the **real visible anchor text** of each link, captured during crawl from the `<a>` element. Empty-anchor links (e.g. image-only) store `""`. The literal sentinel `wp:auto` is the historical placeholder from before capture existed — treat `null`/`""`/`wp:auto` (case-insensitive) all as "no real anchor".
- **Trap:** anchor text is only as fresh as the last crawl. A code change that starts capturing/using anchor text does nothing until a re-crawl rewrites the edges (same delete-per-source idempotency rule as placement) — historical rows stay `wp:auto` until then.
- The two crawlers differ: the sitemap/content crawler dedups to **one edge per (source,target)**; the link-map crawler stores **one edge per distinct anchor**. So depending on which ran last, raw content-edge counts can be link-instance-based, not page-based.

# Matching a page against link_graph URLs (URL-form trap)

- `link_graph.source_url`/`target_url` and the `wp_posts` inventory do **not** agree on URL spelling — they vary by protocol (http/https), a leading `www.`, and trailing slash. Comparing raw strings silently misses real edges.
- **How to apply:** to find a page's existing edges, enumerate the realistic spellings (protocol × www × trailing-slash) and match with an indexed `inArray` on both columns. To compare/flag rows in app code, normalize both sides with one key fn (drop scheme, strip leading `www.`, strip trailing slash) so the DB-side match and the app-side key can't drift.
- **Why:** the suggestion engine was originally stateless (never read link_graph), so "already linked" detection is bolt-on and must bridge the two URL conventions itself.

# Over-linked audit counts PAGES, not edges (deliberate exception)

- The "over-linked target" audit counts **distinct source pages** that link to a target via a content link with real anchor text — it dedups by `sourceUrl` on purpose, so the number matches the "N pages link here" drill-down label. This is an intentional divergence from the link_stats edge-count canonical definition above; do **not** "fix" it to use raw edge counts or it will double-count multi-anchor sources from the link-map crawler.
