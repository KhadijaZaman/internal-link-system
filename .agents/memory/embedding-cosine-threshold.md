---
name: Embedding cosine thresholds (text-embedding-3-small)
description: Why on/off-core demand split uses a ~0.42 cosine threshold, not 0.5.
---

# On/off-core cosine threshold

When comparing OpenAI `text-embedding-3-small` vectors with cosine similarity, the
useful range is compressed — observed values cluster roughly 0.19–0.65 even for a
single coherent site. A naive 0.5 cutoff mislabels clearly on-topic items.

**Rule:** use ~0.42 as the default split between "on-core" and "off-core" demand
(Site Authority snapshot). Keep it configurable (e.g. `?threshold` query param).

**Why:** empirically validated on Wellows. At 0.5, on-core service queries
("content marketing services" 0.440, "technical seo agency" 0.499) fall below the
line and look off-core. At 0.42 the lead-magnet family is cleanly off-core
("business ideas" 0.19, "startup ideas" 0.286, "hottest ai startups" 0.378) while
service queries land on-core. The separation between the two clusters is wide; the
absolute numbers are just shifted down vs. what you'd expect from other models.

**How to apply:** don't hardcode 0.5 for any new embedding-similarity gate built on
text-embedding-3-small. Sample real pairs first, then pick a threshold in the gap
between the clusters. The same compression affects other gates (semantic linking
relevance scoring) — calibrate against real data, not intuition.
