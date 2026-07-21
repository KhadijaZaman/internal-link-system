import {
  db,
  similarityRunsTable,
  type SimilarityRun,
  type SimilarityResults,
  type SimilarityArticleResult,
  type SimilarityClusterResult,
} from "@workspace/db";
import { and, asc, eq, lt, isNull, or } from "drizzle-orm";
import { fetchPageInHouse } from "../integrations/htmlFetch";
import { embedText } from "../integrations/openaiEmbed";
import {
  analyzeArticleContent,
  type ArticleAnalysis,
} from "../integrations/openaiArticleAnalysis";
import { generateClusterLabels } from "../integrations/openaiClusterLabels";
import { cosineSim } from "../lib/semanticScorer";
import { louvain } from "../lib/louvain";
import { withDbRetry } from "../lib/dbRetry";
import { logger } from "../lib/logger";

const STALE_MS = 3 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this analysis was in progress. Start a new analysis to try again.";
/** Parallel fetch+embed+analyze workers. */
const CONCURRENCY = 5;
/** Floor for showing a pair in an article's "Similar articles" list. */
const SIMILAR_DISPLAY_THRESHOLD = 0.35;
/** Max similar articles listed per article. */
const SIMILAR_TOP_N = 10;
/**
 * Minimum cosine similarity for a clustering edge. Matches the knowledge
 * graph's SEMANTIC_THRESHOLD: text-embedding-3-small cosines are compressed
 * (on/off-topic splits around ~0.42), so 0.45 keeps genuinely related pairs.
 */
const CLUSTER_EDGE_THRESHOLD = 0.45;
const LOUVAIN_RESOLUTION = 1.0;
const UNCLUSTERED_LABEL = "Unclustered";

interface WorkingArticle extends SimilarityArticleResult {
  embedding: number[] | null;
}

async function updateRun(
  runId: number,
  set: Partial<typeof similarityRunsTable.$inferInsert>,
): Promise<void> {
  await withDbRetry(
    () =>
      db
        .update(similarityRunsTable)
        .set({ ...set, heartbeatAt: new Date() })
        .where(eq(similarityRunsTable.id, runId)),
    { label: `similarity_run_update:${runId}` },
  );
}

/** Mark runs whose process died (stale heartbeat) as interrupted. */
export async function reconcileStaleSimilarityRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  await withDbRetry(
    () =>
      db
        .update(similarityRunsTable)
        .set({
          status: "interrupted",
          error: INTERRUPTED_MESSAGE,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(similarityRunsTable.status, "running"),
            or(
              lt(similarityRunsTable.heartbeatAt, cutoff),
              isNull(similarityRunsTable.heartbeatAt),
            ),
          ),
        ),
    { label: "similarity_runs_reconcile" },
  );
}

export async function runAnalyzeSimilarity(): Promise<void> {
  await reconcileStaleSimilarityRuns();
  // Drain queued runs one at a time until the queue is empty.
  for (;;) {
    const [run] = await withDbRetry(
      () =>
        db
          .select()
          .from(similarityRunsTable)
          .where(eq(similarityRunsTable.status, "queued"))
          .orderBy(asc(similarityRunsTable.createdAt))
          .limit(1),
      { label: "similarity_next_queued" },
    );
    if (!run) return;

    await updateRun(run.id, {
      status: "running",
      startedAt: new Date(),
      error: null,
      progressDone: 0,
      progressTotal: run.urls.length,
    });
    try {
      const results = await processRun(run);
      await updateRun(run.id, {
        status: "complete",
        results,
        progressDone: run.urls.length,
        finishedAt: new Date(),
      });
      logger.info(
        { runId: run.id, articles: results.articles.length, clusters: results.clusters.length },
        "Similarity analysis complete",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ runId: run.id, err: e }, "Similarity analysis failed");
      await updateRun(run.id, {
        status: "failed",
        error: msg,
        finishedAt: new Date(),
      });
    }
  }
}

async function processRun(run: SimilarityRun): Promise<SimilarityResults> {
  const urls = run.urls;
  const articles: WorkingArticle[] = urls.map((url) => ({
    url,
    finalUrl: null,
    title: null,
    wordCount: null,
    topics: [],
    mainTheme: null,
    error: null,
    similar: [],
    embedding: null,
  }));

  // Fetch + embed + analyze each URL with a bounded worker pool. Every
  // failure is per-article: record the error and keep going.
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= articles.length) return;
      const a = articles[idx]!;
      try {
        const page = await fetchPageInHouse(a.url);
        a.finalUrl = page.url;
        a.title = page.title || page.h1 || null;
        a.wordCount = page.wordCount;
        const embedInput = `${page.title}\n\n${page.bodyText}`;
        const [embedding, analysis] = await Promise.all([
          embedText(embedInput),
          analyzeArticleContent(page.title, page.bodyText) as Promise<ArticleAnalysis>,
        ]);
        a.embedding = embedding;
        a.topics = analysis.topics;
        a.mainTheme = analysis.mainTheme;
      } catch (e) {
        a.error = e instanceof Error ? e.message : String(e);
        logger.warn({ url: a.url, err: e }, "Similarity article failed; continuing");
      }
      done++;
      await updateRun(run.id, { progressDone: done });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, articles.length) }, () => worker()),
  );

  // Pairwise cosine similarity between all successfully embedded articles.
  const embedded = articles
    .map((a, i) => ({ a, i }))
    .filter((x) => x.a.embedding !== null);
  const sims = new Map<string, number>();
  for (let x = 0; x < embedded.length; x++) {
    for (let y = x + 1; y < embedded.length; y++) {
      const ai = embedded[x]!;
      const bi = embedded[y]!;
      const sim = cosineSim(ai.a.embedding!, bi.a.embedding!);
      sims.set(`${ai.i},${bi.i}`, sim);
    }
  }
  const simOf = (i: number, j: number): number =>
    sims.get(i < j ? `${i},${j}` : `${j},${i}`) ?? 0;

  for (const { a, i } of embedded) {
    a.similar = embedded
      .filter((o) => o.i !== i)
      .map((o) => ({
        url: o.a.url,
        title: o.a.title,
        sim: Math.round(simOf(i, o.i) * 1000) / 1000,
      }))
      .filter((s) => s.sim >= SIMILAR_DISPLAY_THRESHOLD)
      .sort((p, q) => q.sim - p.sim)
      .slice(0, SIMILAR_TOP_N);
  }

  // Cluster via Louvain on edges above the semantic threshold. Node ids are
  // positions within `embedded` so the graph stays compact.
  const edges: Array<[number, number, number]> = [];
  for (let x = 0; x < embedded.length; x++) {
    for (let y = x + 1; y < embedded.length; y++) {
      const sim = simOf(embedded[x]!.i, embedded[y]!.i);
      if (sim >= CLUSTER_EDGE_THRESHOLD) edges.push([x, y, sim]);
    }
  }
  const labels =
    embedded.length > 0
      ? louvain(embedded.length, edges, LOUVAIN_RESOLUTION)
      : [];
  const groups = new Map<number, number[]>();
  labels.forEach((lab, x) => {
    const g = groups.get(lab);
    if (g) g.push(x);
    else groups.set(lab, [x]);
  });

  const realGroups = [...groups.values()]
    .filter((members) => members.length >= 2)
    .sort((a, b) => b.length - a.length);
  const singletons = [...groups.values()]
    .filter((members) => members.length < 2)
    .flat();

  // AI labels from member topics; fallback to the first member's title.
  const labelInputs = realGroups.map((members) => {
    const first = embedded[members[0]!]!.a;
    const keywords = members.flatMap((x) => embedded[x]!.a.topics);
    return {
      fallback:
        first.title != null
          ? first.title.length > 60
            ? `${first.title.slice(0, 57)}…`
            : first.title
          : "Topic",
      keywords: keywords.length > 0 ? keywords : [first.title ?? first.url],
    };
  });
  const clusterLabels = await generateClusterLabels(labelInputs);

  const clusters: SimilarityClusterResult[] = realGroups.map((members, ci) => ({
    label: clusterLabels[ci] ?? `Topic ${ci + 1}`,
    memberUrls: members.map((x) => embedded[x]!.a.url),
  }));
  if (singletons.length > 0) {
    clusters.push({
      label: UNCLUSTERED_LABEL,
      memberUrls: singletons.map((x) => embedded[x]!.a.url),
    });
  }

  return {
    articles: articles.map(({ embedding: _e, ...rest }) => rest),
    clusters,
  };
}
