---
name: GSC comparison windows
description: Durable rules for comparable Search Console period analysis and distinguishing new data from missing comparison data.
---

Build comparative GSC analyses from the same chunk size in both periods: equal, adjacent windows assembled from weekly calls and ending three days behind today. Never compare a weekly-chunked period with a single long-range call, because GSC anonymization can make the returned datasets differ.

**Why:** Search Console query rows are anonymized and can vary with request chunking. Separately, a successful prior-period fetch can legitimately return zero for every current query; inferring “comparison unavailable” from zero/null prior metrics makes an all-new result indistinguishable from legacy data.

**How to apply:** Persist an explicit run-level comparison-complete/window signal. Use that signal to distinguish legacy/unavailable reports from completed comparisons, while treating a zero prior denominator as “New” with null percentage growth rather than infinity.