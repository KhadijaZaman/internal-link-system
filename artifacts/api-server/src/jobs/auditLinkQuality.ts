import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  pageClassificationsTable,
  linkGraphTable,
} from "@workspace/db";
import { cosineSim, tierAllowed, isBannedAnchor } from "../lib/semanticScorer";
import { linkQualityFlags } from "../lib/insights";
import { canonicalPath } from "../lib/urlCanon";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";

const UPDATE_BATCH = 500;

/** Join key for URL-form tolerance: canonical path when resolvable, raw URL otherwise. */
function urlJoinKey(url: string, siteHost: string): string {
  return canonicalPath(url, siteHost) ?? url;
}

/**
 * audit_link_quality — scores every EXISTING content link in link_graph with
 * the same primitives the suggestion engine uses for NEW links:
 *  - off_topic: source→target embedding cosine below LINK_OFF_TOPIC_SIMILARITY
 *  - tier_violation: donor→receiver tier flow disallowed by SOP §7.2.1
 *  - generic_anchor: banned anchor text ("click here", bare URLs, ...)
 *
 * Too heavy for read time (embeddings × edges), so results are persisted on
 * link_graph (audit_similarity / audit_flags / audited_at) and served by the
 * /link-graph route. Manual trigger only — pure DB + math, no API spend.
 * Idempotent: every content edge is re-scored on each run; edges created by
 * a later re-crawl stay NULL (= not audited yet) until the next run.
 */
export async function runAuditLinkQuality(site: SiteContext): Promise<void> {
  const [posts, classifications, edges] = await withDbRetry(
    () =>
      Promise.all([
        db
          .select({ url: wpPostsTable.url, embedding: wpPostsTable.embedding })
          .from(wpPostsTable)
          .where(and(eq(wpPostsTable.siteId, site.id), isNotNull(wpPostsTable.embedding))),
        db
          .select({ url: pageClassificationsTable.url, tier: pageClassificationsTable.tier })
          .from(pageClassificationsTable)
          .where(eq(pageClassificationsTable.siteId, site.id)),
        db
          .select({
            id: linkGraphTable.id,
            sourceUrl: linkGraphTable.sourceUrl,
            targetUrl: linkGraphTable.targetUrl,
            anchorText: linkGraphTable.anchorText,
          })
          .from(linkGraphTable)
          .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.placement, "content"))),
      ]),
    { label: "audit_link_quality:load" },
  );

  const embeddingByKey = new Map<string, number[]>();
  for (const p of posts) {
    if (p.embedding) embeddingByKey.set(urlJoinKey(p.url, site.host), p.embedding);
  }
  const tierByKey = new Map<string, number>();
  for (const c of classifications) {
    if (c.tier !== null) tierByKey.set(urlJoinKey(c.url, site.host), c.tier);
  }

  const now = new Date();
  let withEmbeddings = 0;
  const flagCounts: Record<string, number> = {};
  const updates: { id: number; similarity: number | null; flags: string[] }[] = [];

  for (const e of edges) {
    const srcKey = urlJoinKey(e.sourceUrl, site.host);
    const tgtKey = urlJoinKey(e.targetUrl, site.host);
    const srcEmb = embeddingByKey.get(srcKey) ?? null;
    const tgtEmb = embeddingByKey.get(tgtKey) ?? null;
    const similarity = srcEmb && tgtEmb ? cosineSim(srcEmb, tgtEmb) : null;
    if (similarity !== null) withEmbeddings++;

    const donorTier = tierByKey.get(srcKey) ?? null;
    const receiverTier = tierByKey.get(tgtKey) ?? null;
    const tierViolation =
      donorTier !== null && receiverTier !== null && !tierAllowed(donorTier, receiverTier);

    const flags = linkQualityFlags({
      similarity,
      tierViolation,
      anchorBanned: e.anchorText ? isBannedAnchor(e.anchorText) : false,
    });
    for (const f of flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    updates.push({ id: e.id, similarity, flags });
  }

  // Batched UPDATE ... FROM (VALUES ...) — one round trip per 500 edges
  // instead of one per edge.
  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const batch = updates.slice(i, i + UPDATE_BATCH);
    const values = sql.join(
      batch.map(
        (u) =>
          sql`(${u.id}::int, ${u.similarity}::double precision, ${JSON.stringify(u.flags)}::jsonb)`,
      ),
      sql`, `,
    );
    await withDbRetry(
      () =>
        db.execute(sql`
          UPDATE link_graph AS lg
          SET audit_similarity = v.sim,
              audit_flags = v.flags,
              audited_at = ${now.toISOString()}::timestamptz
          FROM (VALUES ${values}) AS v(id, sim, flags)
          WHERE lg.id = v.id
        `),
      { label: "audit_link_quality:update" },
    );
  }

  logger.info(
    {
      contentEdges: edges.length,
      withEmbeddings,
      flagCounts,
    },
    "Link quality audit complete",
  );
}
