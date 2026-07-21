/**
 * Deterministic Louvain community detection (modularity optimization).
 * Returns a community id per original node. Handles dense graphs far
 * better than label propagation, which collapses them into one blob.
 *
 * @param n number of nodes (ids 0..n-1)
 * @param inputLinks undirected weighted edges as [a, b, weight]
 * @param resolution 1.0 is standard modularity; raise above 1 if clustering
 *   collapses into too-few communities.
 */
export function louvain(
  n: number,
  inputLinks: Array<[number, number, number]>,
  resolution: number,
): number[] {
  let nodeCount = n;
  let links = inputLinks;
  const mapping = Array.from({ length: n }, (_, i) => i);

  for (let level = 0; level < 10; level++) {
    const adj: Array<Map<number, number>> = Array.from(
      { length: nodeCount },
      () => new Map(),
    );
    const degree = new Array<number>(nodeCount).fill(0);
    let m2 = 0;
    for (const [a, b, w] of links) {
      if (a === b) {
        adj[a].set(a, (adj[a].get(a) ?? 0) + w);
        degree[a] += 2 * w;
        m2 += 2 * w;
        continue;
      }
      adj[a].set(b, (adj[a].get(b) ?? 0) + w);
      adj[b].set(a, (adj[b].get(a) ?? 0) + w);
      degree[a] += w;
      degree[b] += w;
      m2 += 2 * w;
    }
    if (m2 === 0) break;

    const comm = Array.from({ length: nodeCount }, (_, i) => i);
    const tot = degree.slice();
    let improvedAny = false;
    for (let sweep = 0; sweep < 25; sweep++) {
      let moved = false;
      for (let i = 0; i < nodeCount; i++) {
        const ci = comm[i];
        const wc = new Map<number, number>();
        for (const [j, w] of adj[i]) {
          if (j === i) continue;
          wc.set(comm[j], (wc.get(comm[j]) ?? 0) + w);
        }
        tot[ci] -= degree[i];
        let best = ci;
        let bestGain =
          (wc.get(ci) ?? 0) - (resolution * tot[ci] * degree[i]) / m2;
        for (const [c, w] of wc) {
          if (c === ci) continue;
          const gain = w - (resolution * tot[c] * degree[i]) / m2;
          if (gain > bestGain + 1e-12) {
            best = c;
            bestGain = gain;
          }
        }
        tot[best] += degree[i];
        if (best !== ci) {
          comm[i] = best;
          moved = true;
          improvedAny = true;
        }
      }
      if (!moved) break;
    }
    if (!improvedAny) break;

    // Renumber communities compactly.
    const renum = new Map<number, number>();
    for (let i = 0; i < nodeCount; i++) {
      let r = renum.get(comm[i]);
      if (r === undefined) {
        r = renum.size;
        renum.set(comm[i], r);
      }
      comm[i] = r;
    }
    for (let i = 0; i < n; i++) mapping[i] = comm[mapping[i]];

    // Aggregate the graph for the next level.
    const agg = new Map<string, number>();
    for (const [a, b, w] of links) {
      const ca = comm[a];
      const cb = comm[b];
      const key = ca <= cb ? `${ca},${cb}` : `${cb},${ca}`;
      agg.set(key, (agg.get(key) ?? 0) + w);
    }
    links = [...agg.entries()].map(([k, w]) => {
      const [a, b] = k.split(",").map(Number);
      return [a, b, w] as [number, number, number];
    });
    nodeCount = renum.size;
    if (nodeCount <= 1) break;
  }
  return mapping;
}
