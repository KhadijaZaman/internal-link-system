---
name: Paid API request claims
description: Safe durable claiming and retry semantics for paid external API calls.
---

Paid external API work must use a durable claim with a unique ownership token. Result writes and claim release must both require that same token, and the client timeout must be shorter than the claim lease.

When request delivery or completion is ambiguous—timeout, transport failure, malformed response, or a local persistence failure after the response—retain the claim until lease expiry. Release immediately only for a known completed outcome or a provider-confirmed no-charge rejection.

**Why:** A timeout can occur after the provider accepted and charged a request. Immediate retry can buy the same data twice, while a timestamp-only lease lets an expired worker overwrite or clear a replacement worker’s claim.

**How to apply:** Use this pattern for any live paid POST that populates a cache or background enrichment. Add regression coverage for overlapping workers, stale-owner replacement, and ambiguous post-delivery failure.