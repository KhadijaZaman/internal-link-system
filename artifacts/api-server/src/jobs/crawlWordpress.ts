import { sql, eq, notInArray, or } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  pageClassificationsTable,
  linkGraphTable,
} from "@workspace/db";
import { fetchAllSitemapContent } from "../integrations/sitemapContent";
import { embedText } from "../integrations/openaiEmbed";
import {
  classifyPage,
  linkQuotaFromWordCount,
} from "../integrations/classifyPage";
import { recomputeStats } from "./crawlLinkMap";
import { chainActionQueueRecompute } from "../services/actionQueue";
import { logger } from "../lib/logger";

const CLASSIFY_CONCURRENCY = 3;
const EMBED_CONCURRENCY = 4;

interface RunOptions {
  reembedAll?: boolean;
}

async function processConcurrent<T>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try {
          await fn(items[i]!);
        } catch (e) {
          logger.warn({ err: e }, "Concurrent worker error");
        }
      }
    }),
  );
}

export async function runCrawlWordpress(opts: RunOptions = {}): Promise<void> {
  logger.info("Content crawl: starting (sitemap source)");
  const items = await fetchAllSitemapContent();
  logger.info({ count: items.length }, "Content crawl: fetched");

  // Persist posts (url is PK; upsert on conflict)
  for (const it of items) {
    await db
      .insert(wpPostsTable)
      .values({
        url: it.url,
        type: it.type,
        title: it.title,
        slug: it.slug,
        publishDate: it.publishDate,
        modifiedDate: it.modifiedDate,
        excerpt: it.excerpt,
        bodyText: it.bodyText,
        h1: it.h1,
        h2List: it.h2List,
        focusKeyword: it.focusKeyword,
        wordCount: it.wordCount,
        outboundInternalLinks: it.outboundInternalLinks,
        crawledAt: new Date(),
      })
      .onConflictDoUpdate({
        target: wpPostsTable.url,
        set: {
          type: it.type,
          title: it.title,
          slug: it.slug,
          publishDate: it.publishDate,
          modifiedDate: it.modifiedDate,
          excerpt: it.excerpt,
          bodyText: it.bodyText,
          h1: it.h1,
          h2List: it.h2List,
          focusKeyword: it.focusKeyword,
          wordCount: it.wordCount,
          outboundInternalLinks: it.outboundInternalLinks,
          crawledAt: new Date(),
        },
      });
  }
  logger.info("Content crawl: posts persisted");

  // Reconcile: remove wp_posts rows whose URL is no longer in the sitemap.
  // Without this, deleted pages would linger forever in the embedding pool
  // and the semantic linker would keep proposing links to/from dead URLs.
  const currentUrls = items.map((it) => it.url);
  if (currentUrls.length > 0) {
    const removed = await db
      .delete(wpPostsTable)
      .where(notInArray(wpPostsTable.url, currentUrls))
      .returning({ url: wpPostsTable.url });
    if (removed.length > 0) {
      logger.info({ count: removed.length }, "Content crawl: removed stale posts");
    }
    // Purge link_graph edges whose source OR target no longer exists in the
    // refreshed inventory. Stats and PageRank will be recomputed below.
    try {
      const purged = await db
        .delete(linkGraphTable)
        .where(
          or(
            notInArray(linkGraphTable.sourceUrl, currentUrls),
            notInArray(linkGraphTable.targetUrl, currentUrls),
          ),
        )
        .returning({ id: linkGraphTable.sourceUrl });
      if (purged.length > 0) {
        logger.info({ count: purged.length }, "Content crawl: purged orphan edges");
      }
    } catch (e) {
      logger.warn({ err: e }, "Content crawl: orphan edge purge failed");
    }
  }

  // Sync link_graph from outbound links discovered during crawl. Source is
  // canonical: for each crawled page we delete prior edges and re-insert
  // the current set with the visible anchor text captured during extraction.
  // Links with no visible anchor text (e.g. image-only links) store an empty
  // string. This makes the operation idempotent.
  const sourceUrls = items.map((it) => it.url);
  for (const src of sourceUrls) {
    try {
      await db.delete(linkGraphTable).where(eq(linkGraphTable.sourceUrl, src));
    } catch (e) {
      logger.warn({ err: e, src }, "Link graph clear failed");
    }
  }
  for (const it of items) {
    for (const link of it.outboundInternalLinks) {
      try {
        await db
          .insert(linkGraphTable)
          .values({
            sourceUrl: it.url,
            targetUrl: link.url,
            anchorText: link.anchorText,
            surroundingText: null,
            // Tagged by sitemapContent's HTML classifier — body links are
            // "content", nav/header/footer get stored for reporting only.
            placement: link.placement,
          })
          .onConflictDoNothing();
      } catch (e) {
        logger.warn({ err: e }, "Link graph insert failed");
      }
    }
  }

  // Recompute link_stats + PageRank so suggestion pipeline sees fresh graph
  try {
    await recomputeStats();
    logger.info("Content crawl: link stats recomputed");
  } catch (e) {
    logger.warn({ err: e }, "Content crawl: recomputeStats failed");
  }
  // Orphan/dead-end flags may have changed — refresh the action queue.
  await chainActionQueueRecompute("crawl_wordpress");

  // Embed: re-embed when forced, when no embedding exists, or when the
  // post has been modified since the last embedding (on-demand refresh).
  const existingRows = await db
    .select({
      url: wpPostsTable.url,
      embeddedAt: wpPostsTable.embeddedAt,
    })
    .from(wpPostsTable)
    .where(sql`${wpPostsTable.embedding} IS NOT NULL`);
  const embeddedAtByUrl = new Map(
    existingRows.map((r) => [r.url, r.embeddedAt]),
  );
  const embedItems = items.filter((it) => {
    if (opts.reembedAll) return true;
    const prev = embeddedAtByUrl.get(it.url);
    if (!prev) return true;
    if (it.modifiedDate && it.modifiedDate > prev) return true;
    return false;
  });
  logger.info({ count: embedItems.length }, "Content crawl: embedding");

  await processConcurrent(embedItems, EMBED_CONCURRENCY, async (it) => {
    const first1000Words = it.bodyText.split(/\s+/).slice(0, 1000).join(" ");
    const text = [it.title, it.h1, first1000Words]
      .filter(Boolean)
      .join("\n\n");
    if (!text.trim()) return;
    const vec = await embedText(text);
    await db
      .update(wpPostsTable)
      .set({ embedding: vec, embeddedAt: new Date() })
      .where(eq(wpPostsTable.url, it.url));
  });
  logger.info("Content crawl: embeddings done");

  // Classify pages that don't already have manual edits
  const existingClass = await db.select().from(pageClassificationsTable);
  const editedUrls = new Set(
    existingClass.filter((c) => c.manuallyEdited).map((c) => c.url),
  );
  const classifiedUrls = new Set(existingClass.map((c) => c.url));
  const toClassify = items.filter(
    (it) => !editedUrls.has(it.url) && (opts.reembedAll || !classifiedUrls.has(it.url)),
  );
  logger.info({ count: toClassify.length }, "Content crawl: classifying");

  await processConcurrent(toClassify, CLASSIFY_CONCURRENCY, async (it) => {
    const result = await classifyPage({
      url: it.url,
      title: it.title,
      h1: it.h1,
      excerpt: it.excerpt,
      bodyExcerpt: it.bodyText,
      wordCount: it.wordCount,
      focusKeyword: it.focusKeyword,
    });
    if (!result) return;
    const quota = linkQuotaFromWordCount(it.wordCount);
    await db
      .insert(pageClassificationsTable)
      .values({
        url: it.url,
        tier: result.tier,
        centralEntity: result.centralEntity,
        subEntity: result.subEntity,
        parentRootUrl: result.parentRootUrl,
        canonicalQuery: result.canonicalQuery,
        anchorVariants: result.anchorVariants,
        linkQuotaMin: quota.min,
        linkQuotaMax: quota.max,
        topicalBordersMatch: result.topicalBordersMatch,
        manuallyEdited: false,
        classifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pageClassificationsTable.url,
        set: {
          tier: result.tier,
          centralEntity: result.centralEntity,
          subEntity: result.subEntity,
          parentRootUrl: result.parentRootUrl,
          canonicalQuery: result.canonicalQuery,
          anchorVariants: result.anchorVariants,
          linkQuotaMin: quota.min,
          linkQuotaMax: quota.max,
          topicalBordersMatch: result.topicalBordersMatch,
          classifiedAt: new Date(),
        },
      });
  });
  logger.info("Content crawl: done");
}

export async function runReembedAll(): Promise<void> {
  await runCrawlWordpress({ reembedAll: true });
}
