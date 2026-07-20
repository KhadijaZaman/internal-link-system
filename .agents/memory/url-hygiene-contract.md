---
name: URL hygiene contract
description: Rules every future phase must respect around the canonical URL layer, blocklist semantics, and the pages registry.
---

**Rule:** All URL storage/joins go through the canonical normalizer + url_blocklist; metrics that collapse onto one canonical path are merged (SUM + impression-weighted position), never overwritten.
**Why:** GSC stores `#fragment` and `?param` variants as separate pages; overwriting made page metrics 50-200x wrong and the three dashboard views disagreed until one canonical `pages` registry + one shared count query fixed it.
**How to apply:** New ingestion or read paths in later phases (GA4 scoping, work items, etc.) must canonicalize before insert and re-aggregate after collapsing — check the hygiene lib first, don't hand-roll normalization.

**Blocklist semantics:** path patterns with `*` or trailing `/` are prefix matches; bare paths (crawler-404 auto-entries) are EXACT matches.
**Why:** prefix-matching an exact 404 path (e.g. `/pricing-old`) silently blocklisted every page sharing that prefix across ALL ingestion and reads — an invisible data-loss failure mode.

**Pages registry only grows:** nothing un-registers a page, so any "content pages" count must apply the blocklist at read time (in JS — patterns aren't SQL-friendly) and crawls must write 404 status onto existing rows; otherwise counts drift upward from reality.
