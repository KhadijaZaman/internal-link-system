import { sql, and, eq, notInArray, or } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  pageClassificationsTable,
  linkGraphTable,
  pagesTable,
} from "@workspace/db";
import { fetchAllSitemapContent } from "../integrations/sitemapContent";
import {
  canonicalPath,
  canonicalUrl,
  isBlockedPath,
  loadBlockRegexes,
} from "../lib/urlCanon";
import { sectionFor } from "../lib/sections";
import { getLegacySite } from "../lib/site";
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
  // Content crawl stays legacy-site-only until per-site job scheduling lands.
  const site = await getLegacySite();
  logger.info("Content crawl: starting (sitemap source)");
  const rawItems = await fetchAllSitemapContent();

  // URL hygiene: every URL entering wp_posts / link_graph is canonicalized
  // (no fragment/query/trailing slash, lowercase) and blocklisted paths are
  // dropped, so all stores join on the same canonical form.
  const block = await loadBlockRegexes(site.id);
  const seenPaths = new Set<string>();
  const items: Array<(typeof rawItems)[number] & { path: string }> = [];
  for (const it of rawItems) {
    const path = canonicalPath(it.url, site.host);
    if (!path || isBlockedPath(path, block)) continue;
    // Variants collapsing to the same canonical path: keep the first.
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    items.push({
      ...it,
      path,
      url: canonicalUrl(path, site.host),
      outboundInternalLinks: it.outboundInternalLinks.flatMap((l) => {
        const lp = canonicalPath(l.url, site.host);
        if (!lp || isBlockedPath(lp, block)) return [];
        return [{ ...l, url: canonicalUrl(lp, site.host) }];
      }),
    });
  }
  logger.info(
    { raw: rawItems.length, canonical: items.length },
    "Content crawl: fetched (raw → canonical)",
  );

  // Guard against partial crawls: the reconcile below deletes every post and
  // link-graph edge not present in `items`, so acting on a suspiciously small
  // fetch would wipe real inventory (this happened when one child sitemap
  // failed for a night). Abort before any writes; the job surfaces as failed.
  const existingCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wpPostsTable)
    .where(eq(wpPostsTable.siteId, site.id));
  const existingCount = existingCountRows[0]?.count ?? 0;
  const allowShrink = process.env["CRAWL_ALLOW_SHRINK"] === "1";
  if (!allowShrink && existingCount >= 20 && items.length < existingCount * 0.8) {
    throw new Error(
      `Content crawl aborted: sitemap fetch returned only ${items.length} pages ` +
        `but ${existingCount} are already tracked (>20% drop). Refusing to ` +
        `reconcile to avoid mass-deleting inventory after a partial fetch. ` +
        `If the site really removed this many pages, set CRAWL_ALLOW_SHRINK=1 ` +
        `and run the crawl once to accept the smaller inventory.`,
    );
  }

  // Persist posts (url is PK; upsert on conflict)
  for (const it of items) {
    await db
      .insert(wpPostsTable)
      .values({
        url: it.url,
        siteId: site.id,
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
        target: [wpPostsTable.url, wpPostsTable.siteId],
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

  // Canonical page registry: WP/sitemap is one of the sources that "sees" a
  // page. A successful content fetch implies the page resolves (status 200).
  for (const it of items) {
    await db
      .insert(pagesTable)
      .values({
        path: it.path,
        url: it.url,
        siteId: site.id,
        title: it.title,
        section: sectionFor(it.url),
        inWp: true,
        inSitemap: true,
        httpStatus: 200,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [pagesTable.path, pagesTable.siteId],
        set: {
          title: it.title,
          section: sectionFor(it.url),
          inWp: true,
          inSitemap: true,
          httpStatus: 200,
          updatedAt: new Date(),
        },
      });
  }
  logger.info("Content crawl: pages registry updated");

  // Reconcile: remove wp_posts rows whose URL is no longer in the sitemap.
  // Without this, deleted pages would linger forever in the embedding pool
  // and the semantic linker would keep proposing links to/from dead URLs.
  const currentUrls = items.map((it) => it.url);
  if (currentUrls.length > 0) {
    const removed = await db
      .delete(wpPostsTable)
      .where(and(eq(wpPostsTable.siteId, site.id), notInArray(wpPostsTable.url, currentUrls)))
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
          and(
            eq(linkGraphTable.siteId, site.id),
            or(
              notInArray(linkGraphTable.sourceUrl, currentUrls),
              notInArray(linkGraphTable.targetUrl, currentUrls),
            ),
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
      await db
        .delete(linkGraphTable)
        .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.sourceUrl, src)));
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
            siteId: site.id,
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
    await recomputeStats(site.id);
    logger.info("Content crawl: link stats recomputed");
  } catch (e) {
    logger.warn({ err: e }, "Content crawl: recomputeStats failed");
  }
  // Orphan/dead-end flags may have changed — refresh the action queue.
  await chainActionQueueRecompute("crawl_wordpress", site.id);

  // Embed: re-embed when forced, when no embedding exists, or when the
  // post has been modified since the last embedding (on-demand refresh).
  const existingRows = await db
    .select({
      url: wpPostsTable.url,
      embeddedAt: wpPostsTable.embeddedAt,
    })
    .from(wpPostsTable)
    .where(and(eq(wpPostsTable.siteId, site.id), sql`${wpPostsTable.embedding} IS NOT NULL`));
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
      .where(and(eq(wpPostsTable.siteId, site.id), eq(wpPostsTable.url, it.url)));
  });
  logger.info("Content crawl: embeddings done");

  // Classify pages that don't already have manual edits
  const existingClass = await db
    .select()
    .from(pageClassificationsTable)
    .where(eq(pageClassificationsTable.siteId, site.id));
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
        siteId: site.id,
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
        target: [pageClassificationsTable.url, pageClassificationsTable.siteId],
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
