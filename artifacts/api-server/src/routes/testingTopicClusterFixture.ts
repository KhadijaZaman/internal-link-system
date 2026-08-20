import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  pagesTable,
  sitesTable,
  topicalMapNodesTable,
  topicalMapsTable,
  wpPostsTable,
} from "@workspace/db";
import { requireAuth, type AuthedRequest } from "../lib/auth";

const router: IRouter = Router();
const E2E_FIXTURE_HOST_SUFFIX = ".e2e-fixture.test";

function fixtureEmbedding(similarity: number): number[] {
  const vector = Array<number>(1536).fill(0);
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity ** 2);
  return vector;
}

function fixtureHostForUser(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 20);
  return `topic-clusters-${digest}${E2E_FIXTURE_HOST_SUFFIX}`;
}

/**
 * Browser-test setup route. It is unavailable outside development and only
 * rewrites a deterministic synthetic site owned by the signed-in caller.
 * No crawler, embedding, or topical-map job is invoked.
 */
router.post("/testing/topic-clusters/fixture", requireAuth, async (req, res, next) => {
  if (process.env["NODE_ENV"] !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const userId = (req as AuthedRequest).userId!;
    const host = fixtureHostForUser(userId);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.host, host))
        .limit(1);
      const site =
        existing ??
        (
          await tx
            .insert(sitesTable)
            .values({
              ownerUserId: userId,
              domain: `https://${host}`,
              host,
              displayName: "Topic Clusters Browser Fixture",
            })
            .returning()
        )[0]!;

      if (site.ownerUserId !== userId) {
        throw new Error("Fixture ownership mismatch");
      }

      await tx.delete(topicalMapsTable).where(eq(topicalMapsTable.siteId, site.id));
      await tx.delete(wpPostsTable).where(eq(wpPostsTable.siteId, site.id));
      await tx.delete(pagesTable).where(eq(pagesTable.siteId, site.id));

      const [map] = await tx
        .insert(topicalMapsTable)
        .values({
          siteId: site.id,
          status: "complete",
          progressDone: 2,
          progressTotal: 2,
          sourceContext: "Synthetic browser-test data. Never crawl or generate from it.",
          centralEntity: "Synthetic Search Visibility",
          centralSearchIntent: "Verify topic-cluster similar-page rendering",
          finishedAt: new Date(),
          stats: { nodes: 2, published: 1, gaps: 1, pillars: 1 },
        })
        .returning();
      const [pillar] = await tx
        .insert(topicalMapNodesTable)
        .values({
          siteId: site.id,
          mapId: map!.id,
          parentId: null,
          level: "pillar",
          section: "core",
          title: "Synthetic Search Visibility",
          canonicalQuery: "synthetic search visibility",
          attributeOwned: "testing",
          intent: "informational",
          predicate: "verify",
          funnelStage: "top",
          pageType: "guide",
          suggestedSlug: "synthetic-search-visibility",
          suggestedTitle: "Synthetic Search Visibility",
          priority: "high",
          status: "published",
          matchedPagePath: "/fixture/anchor",
          matchSource: "embedding",
          matchConfidence: 1,
          sortOrder: 0,
        })
        .returning();
      await tx.insert(topicalMapNodesTable).values({
        siteId: site.id,
        mapId: map!.id,
        parentId: pillar!.id,
        level: "core_topic",
        section: "core",
        title: "Synthetic Similar Pages",
        canonicalQuery: "synthetic similar pages",
        attributeOwned: "testing",
        intent: "informational",
        predicate: "verify",
        funnelStage: "top",
        pageType: "guide",
        suggestedSlug: "synthetic-similar-pages",
        suggestedTitle: "Synthetic Similar Pages",
        priority: "high",
        status: "gap",
        sortOrder: 1,
      });

      const fixturePages = [
        ["/fixture/anchor", "Fixture Anchor Page", 1],
        ["/fixture/related", "Fixture Related Page", 0.91],
        ["/fixture/threshold", "Fixture Threshold Page", 0.42],
        ["/fixture/more", "Fixture Show More Page", 0.76],
      ] as const;
      await tx.insert(pagesTable).values(
        fixturePages.map(([path, title]) => ({
          siteId: site.id,
          path,
          title,
          url: `https://${host}${path}`,
          inWp: true,
        })),
      );
      await tx.insert(wpPostsTable).values(
        fixturePages.map(([path, title, similarity]) => ({
          siteId: site.id,
          url: `https://${host}${path}`,
          type: "page",
          title,
          slug: path.split("/").filter(Boolean).at(-1) ?? null,
          embedding: fixtureEmbedding(similarity),
        })),
      );
      return { site, map: map! };
    });

    res.status(201).json({
      siteId: result.site.id,
      host: result.site.host,
      mapId: result.map.id,
    });
  } catch (error) {
    next(error);
  }
});

export default router;