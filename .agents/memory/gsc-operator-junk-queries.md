---
name: GSC operator junk queries
description: AI/scraper search-operator queries pollute GSC top-query lists; filter structurally before paid spend, and requeued jobs need heartbeat-based staleness.
---

# GSC operator junk queries

AI fan-out / scraper traffic shows up in GSC top queries as search-operator strings: multi-quoted phrases (`"fintech" "founded in 2020" "backed by"`), parenthesized booleans (`(x) and (y)`), and `site:`/`inurl:`/`intitle:`/`filetype:` prefixes. They have real impressions, so impression-ranked keyword selection picks them up and they poison clustering (mega-clusters, quoted topic names).

**Rules:**
- Filter structurally, not by wordlist: double/curly quotes, operator prefixes, and structural `) and (` / `) or (` booleans. Bare " and " / " or " must stay safe ("pros and cons", "bed and breakfast").
- Filter at selection time, BEFORE any paid per-keyword spend (SERP scraping, embeddings) — filtering at display time still wastes the money.
- Known tradeoff: legit queries containing a double quote (inch marks) get dropped — acceptable for this corpus.

**Requeue/rebuild staleness:** a rebuilt job row keeps its original `createdAt`. Any "stale queued" reconciler must prefer a heartbeat column (set to now on requeue) and only fall back to `createdAt` when heartbeat is null, or requeued rows are instantly marked interrupted.

**Free rebuild pattern:** store the raw paid inputs (SERP URL lists) on result rows so runs can be re-clustered/re-labeled without re-spending; do delete+insert in one transaction and restore prior status+error on failure so paid data is never lost.
