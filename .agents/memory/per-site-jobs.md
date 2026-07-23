---
name: Per-site background jobs
description: Conventions and pitfalls from converting legacy-single-site jobs to per-site scheduling with spend budgets
---

- Every job fn takes `site: SiteContext` first; crons iterate owned sites SEQUENTIALLY (parallel would multiply external API load and blow rate limits). Per-site failures are isolated with try/catch per site.
- **Why sequential:** one misbehaving site must not starve or fail others, and GSC/DataForSEO/Anthropic quotas are shared.
- Spend guardrails: per-run `JobBudget` (llmCalls / serpQueries / crawlPages) built from per-site columns. **Critical pitfall:** when a crawl cap truncates the URL/post set, any "reconcile: delete rows not in fetched set" step must be SKIPPED — reconciling against a deliberately truncated set mass-deletes real inventory (same class of bug as the earlier partial-sitemap incident).
- When a budget cap trims SERP keyword sets, trim to remaining quota rather than hard-failing, but fail clearly if the remainder can't support a meaningful run (<2 queries).
- Legacy-bound integrations (the persistent keyword-movement Google Sheet) should make non-legacy sites a graceful logged no-op, not an error, so multi-site cron sweeps stay green.
- Converting a job: also swap env-derived host/domain/sitemap config for site fields (fallback to config only for the legacy site) — env config silently misclassifies own-vs-competitor hosts for new sites.
