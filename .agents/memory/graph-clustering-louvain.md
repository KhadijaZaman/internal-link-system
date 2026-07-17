---
name: Graph clustering on dense link graphs
description: Why label propagation fails on the site's content-link graph and Louvain is the required approach.
---

Label propagation collapses the Wellows content-link graph (~560 nodes, ~5.3k undirected content-link pairs) into one giant cluster — the graph is too dense and hub-heavy for LP regardless of processing order or edge weights. Deterministic Louvain (modularity optimization, fixed iteration order, resolution 1.0) produces ~8 clean topical clusters in <200ms.

**Why:** LP adopts the majority neighbor label; with dense cross-linking every node's majority converges to the same hub-anchored label. Modularity compares against expected density, so it separates communities even in dense graphs.

**How to apply:** Any future clustering over link_graph/semantic edges should reuse the `louvain()` in the knowledge-graph route (or its approach) rather than label propagation. If clusters ever merge into too few as the site grows, raise the resolution above 1.0. Cluster labels come from slug-token frequency with a uniqueness pass — keep the dedupe or labels collide ("Search · Visibility" appeared twice).

Related: the pgvector top-K lateral join is O(n²) without a vector index — fine at ~600 posts (~200ms), add an HNSW index or short-TTL cache past a few thousand.
