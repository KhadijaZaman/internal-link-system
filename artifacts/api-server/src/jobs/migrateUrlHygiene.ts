import { sql, eq, inArray } from "drizzle-orm";
import {
  db,
  gscSnapshotsTable,
  queryLosersTable,
  inventoryTable,
  wpPostsTable,
  linkGraphTable,
  pageClassificationsTable,
  pagesTable,
  urlBlocklistTable,
} from "@workspace/db";
import {
  canonicalPath,
  canonicalUrl,
  isBlockedPath,
  loadBlockRegexes,
  BLOCKLIST_SEEDS,
} from "../lib/urlCanon";
import { sectionFor } from "../lib/sections";
import { recomputeStats } from "./crawlLinkMap";
import { withDbRetry } from "../lib/dbRetry";
import { logger } from "../lib/logger";

/**
 * One-shot (but idempotent, re-runnable) retroactive URL-hygiene migration.
 *
 * Historical rows in gsc_snapshots / query_losers / inventory / wp_posts /
 * link_graph / page_classifications were written before the canonical
 * normalizer existed, so they contain fragment variants (/page/#anchor),
 * trailing-slash variants, and app-screen paths (/overview/...). This job
 * rewrites every stored URL to its canonical form, merges rows that collapse
 * onto the same canonical key (summing clicks/impressions and
 * impression-weighting position), deletes blocklisted paths, and seeds the
 * canonical `pages` registry from what remains.
 */
export async function runMigrateUrlHygiene(): Promise<void> {
  logger.info("URL hygiene migration: starting");

  // ---- 0. (Re-)seed blocklist patterns; safe on every run.
  for (const s of BLOCKLIST_SEEDS) {
    await withDbRetry(
      () =>
        db
          .insert(urlBlocklistTable)
          .values({ pattern: s.pattern, note: s.note, source: "seed" })
          .onConflictDoNothing(),
      { label: "blocklist seed" },
    );
  }
  const block = await loadBlockRegexes();

  /** Map a stored URL to its canonical URL, or null when it must be deleted. */
  const mapUrl = (u: string): string | null => {
    const p = canonicalPath(u);
    if (!p || isBlockedPath(p, block)) return null;
    return canonicalUrl(p);
  };

  /**
   * Compute the per-table rewrite plan for a list of distinct stored URLs:
   * which to delete outright and which to rewrite to a different canonical.
   */
  const planFor = (urls: string[]) => {
    const toDelete: string[] = [];
    const toRewrite: Array<{ from: string; to: string }> = [];
    for (const u of urls) {
      const m = mapUrl(u);
      if (m === null) toDelete.push(u);
      else if (m !== u) toRewrite.push({ from: u, to: m });
    }
    return { toDelete, toRewrite };
  };

  const chunk = <T>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  // ---- 1. gsc_snapshots: rewrite URLs, drop blocked, merge collapsed rows.
  {
    const distinct = await db
      .selectDistinct({ url: gscSnapshotsTable.url })
      .from(gscSnapshotsTable);
    const { toDelete, toRewrite } = planFor(distinct.map((r) => r.url));
    for (const c of chunk(toDelete, 200)) {
      await withDbRetry(
        () => db.delete(gscSnapshotsTable).where(inArray(gscSnapshotsTable.url, c)),
        { label: "snapshots delete blocked" },
      );
    }
    for (const r of toRewrite) {
      await withDbRetry(
        () =>
          db
            .update(gscSnapshotsTable)
            .set({ url: r.to })
            .where(eq(gscSnapshotsTable.url, r.from)),
        { label: "snapshots rewrite url" },
      );
    }
    // Merge duplicates created by the rewrite: SUM clicks/impressions,
    // impression-weight position (weight floor 1), recompute ctr.
    await withDbRetry(
      () =>
        db.execute(sql`
          WITH dup AS (
            SELECT snapshot_date, url, query
            FROM gsc_snapshots
            GROUP BY snapshot_date, url, query
            HAVING count(*) > 1
          ),
          merged AS (
            SELECT s.snapshot_date, s.url, s.query,
                   min(s.id) AS keep_id,
                   sum(coalesce(s.clicks, 0))::int AS clicks,
                   sum(coalesce(s.impressions, 0))::int AS impressions,
                   sum(coalesce(s.position, 0) * greatest(coalesce(s.impressions, 0), 1))
                     / nullif(sum(greatest(coalesce(s.impressions, 0), 1)), 0) AS position
            FROM gsc_snapshots s
            JOIN dup d ON d.snapshot_date = s.snapshot_date
                      AND d.url = s.url AND d.query = s.query
            GROUP BY s.snapshot_date, s.url, s.query
          ),
          upd AS (
            UPDATE gsc_snapshots g
            SET clicks = m.clicks,
                impressions = m.impressions,
                position = m.position,
                ctr = CASE WHEN m.impressions > 0
                           THEN m.clicks::float / m.impressions ELSE 0 END
            FROM merged m
            WHERE g.id = m.keep_id
            RETURNING g.id
          )
          DELETE FROM gsc_snapshots g
          USING merged m
          WHERE g.snapshot_date = m.snapshot_date
            AND g.url = m.url AND g.query = m.query
            AND g.id <> m.keep_id
        `),
      { label: "snapshots merge duplicates" },
    );
    logger.info(
      { deletedUrls: toDelete.length, rewrittenUrls: toRewrite.length },
      "URL hygiene: gsc_snapshots done",
    );
  }

  // ---- 2. query_losers: rewrite/drop, then keep one row per key.
  {
    const distinct = await db
      .selectDistinct({ url: queryLosersTable.url })
      .from(queryLosersTable);
    const { toDelete, toRewrite } = planFor(distinct.map((r) => r.url));
    for (const c of chunk(toDelete, 200)) {
      await withDbRetry(
        () => db.delete(queryLosersTable).where(inArray(queryLosersTable.url, c)),
        { label: "losers delete blocked" },
      );
    }
    for (const r of toRewrite) {
      await withDbRetry(
        () =>
          db
            .update(queryLosersTable)
            .set({ url: r.to })
            .where(eq(queryLosersTable.url, r.from)),
        { label: "losers rewrite url" },
      );
    }
    // Duplicates after rewrite: keep the variant with the most current
    // impressions (it carried the real page's data; fragment variants are
    // tiny slivers), tie-break on lowest id.
    await withDbRetry(
      () =>
        db.execute(sql`
          DELETE FROM query_losers q
          USING query_losers keep
          WHERE q.week_of = keep.week_of
            AND q.url = keep.url
            AND q.query = keep.query
            AND q.id <> keep.id
            AND (coalesce(keep.curr_impressions, 0) > coalesce(q.curr_impressions, 0)
                 OR (coalesce(keep.curr_impressions, 0) = coalesce(q.curr_impressions, 0)
                     AND keep.id < q.id))
        `),
      { label: "losers dedupe" },
    );
    logger.info(
      { deletedUrls: toDelete.length, rewrittenUrls: toRewrite.length },
      "URL hygiene: query_losers done",
    );
  }

  // ---- 3. inventory (url PK): rewrite with merge-on-collision.
  {
    const rows = await db.select().from(inventoryTable);
    const byCanon = new Map<string, typeof rows>();
    const dropUrls: string[] = [];
    for (const r of rows) {
      const m = mapUrl(r.url);
      if (m === null) {
        dropUrls.push(r.url);
        continue;
      }
      const g = byCanon.get(m);
      if (g) g.push(r);
      else byCanon.set(m, [r]);
    }
    for (const c of chunk(dropUrls, 200)) {
      await withDbRetry(
        () => db.delete(inventoryTable).where(inArray(inventoryTable.url, c)),
        { label: "inventory delete blocked" },
      );
    }
    for (const [canon, group] of byCanon) {
      const needsWork = group.length > 1 || group[0]!.url !== canon;
      if (!needsWork) continue;
      // Merge: prefer the row already at the canonical URL for text fields;
      // sum impressions/clicks; impression-weight position.
      const primary = group.find((g) => g.url === canon) ?? group[0]!;
      let impressions = 0;
      let clicks = 0;
      let posSum = 0;
      let posW = 0;
      for (const g of group) {
        impressions += g.impressions ?? 0;
        clicks += g.clicks ?? 0;
        const w = Math.max(g.impressions ?? 0, 1);
        posSum += (g.position ?? 0) * w;
        posW += w;
      }
      const variantUrls = group.map((g) => g.url).filter((u) => u !== canon);
      if (variantUrls.length > 0) {
        await withDbRetry(
          () => db.delete(inventoryTable).where(inArray(inventoryTable.url, variantUrls)),
          { label: "inventory delete variants" },
        );
      }
      await withDbRetry(
        () =>
          db
            .insert(inventoryTable)
            .values({
              url: canon,
              title: primary.title,
              h1: primary.h1,
              section: sectionFor(canon),
              topQuery: primary.topQuery,
              position: posW > 0 ? posSum / posW : null,
              impressions,
              clicks,
              lastUpdated: new Date(),
            })
            .onConflictDoUpdate({
              target: inventoryTable.url,
              set: {
                position: posW > 0 ? posSum / posW : null,
                impressions,
                clicks,
                section: sectionFor(canon),
                lastUpdated: new Date(),
              },
            }),
        { label: "inventory upsert canonical" },
      );
    }
    logger.info({ dropped: dropUrls.length }, "URL hygiene: inventory done");
  }

  // ---- 4. wp_posts (url PK): rewrite; if the canonical row already exists,
  // drop the variant (canonical row wins — it was crawled under that URL).
  {
    const rows = await db
      .select({ url: wpPostsTable.url })
      .from(wpPostsTable);
    const { toDelete, toRewrite } = planFor(rows.map((r) => r.url));
    for (const c of chunk(toDelete, 200)) {
      await withDbRetry(
        () => db.delete(wpPostsTable).where(inArray(wpPostsTable.url, c)),
        { label: "wp_posts delete blocked" },
      );
    }
    const existing = new Set(rows.map((r) => r.url));
    for (const r of toRewrite) {
      if (existing.has(r.to)) {
        await withDbRetry(
          () => db.delete(wpPostsTable).where(eq(wpPostsTable.url, r.from)),
          { label: "wp_posts drop variant" },
        );
      } else {
        await withDbRetry(
          () =>
            db.update(wpPostsTable).set({ url: r.to }).where(eq(wpPostsTable.url, r.from)),
          { label: "wp_posts rewrite url" },
        );
        existing.add(r.to);
      }
    }
    logger.info(
      { deleted: toDelete.length, rewritten: toRewrite.length },
      "URL hygiene: wp_posts done",
    );
  }

  // ---- 5. page_classifications (url PK): same policy as wp_posts.
  {
    const rows = await db
      .select({ url: pageClassificationsTable.url })
      .from(pageClassificationsTable);
    const { toDelete, toRewrite } = planFor(rows.map((r) => r.url));
    for (const c of chunk(toDelete, 200)) {
      await withDbRetry(
        () =>
          db
            .delete(pageClassificationsTable)
            .where(inArray(pageClassificationsTable.url, c)),
        { label: "classifications delete blocked" },
      );
    }
    const existing = new Set(rows.map((r) => r.url));
    for (const r of toRewrite) {
      if (existing.has(r.to)) {
        await withDbRetry(
          () =>
            db
              .delete(pageClassificationsTable)
              .where(eq(pageClassificationsTable.url, r.from)),
          { label: "classifications drop variant" },
        );
      } else {
        await withDbRetry(
          () =>
            db
              .update(pageClassificationsTable)
              .set({ url: r.to })
              .where(eq(pageClassificationsTable.url, r.from)),
          { label: "classifications rewrite url" },
        );
        existing.add(r.to);
      }
    }
  }

  // ---- 6. link_graph: rewrite both endpoints, drop blocked, dedupe on the
  // (source_url, target_url, anchor_text) unique key keeping the oldest row.
  {
    const sources = await db
      .selectDistinct({ u: linkGraphTable.sourceUrl })
      .from(linkGraphTable);
    const targets = await db
      .selectDistinct({ u: linkGraphTable.targetUrl })
      .from(linkGraphTable);
    const all = Array.from(new Set([...sources.map((r) => r.u), ...targets.map((r) => r.u)]));
    const { toDelete, toRewrite } = planFor(all);
    for (const c of chunk(toDelete, 200)) {
      await withDbRetry(
        () => db.delete(linkGraphTable).where(inArray(linkGraphTable.sourceUrl, c)),
        { label: "link_graph delete blocked sources" },
      );
      await withDbRetry(
        () => db.delete(linkGraphTable).where(inArray(linkGraphTable.targetUrl, c)),
        { label: "link_graph delete blocked targets" },
      );
    }
    for (const r of toRewrite) {
      // A rewrite can collide with an existing identical edge — remove the
      // would-be duplicates first, then update the survivors.
      await withDbRetry(
        () =>
          db.execute(sql`
            DELETE FROM link_graph v
            USING link_graph k
            WHERE v.source_url = ${r.from}
              AND k.source_url = ${r.to}
              AND v.target_url = k.target_url
              AND v.anchor_text IS NOT DISTINCT FROM k.anchor_text
          `),
        { label: "link_graph pre-dedupe source" },
      );
      await withDbRetry(
        () =>
          db
            .update(linkGraphTable)
            .set({ sourceUrl: r.to })
            .where(eq(linkGraphTable.sourceUrl, r.from)),
        { label: "link_graph rewrite source" },
      );
      await withDbRetry(
        () =>
          db.execute(sql`
            DELETE FROM link_graph v
            USING link_graph k
            WHERE v.target_url = ${r.from}
              AND k.target_url = ${r.to}
              AND v.source_url = k.source_url
              AND v.anchor_text IS NOT DISTINCT FROM k.anchor_text
          `),
        { label: "link_graph pre-dedupe target" },
      );
      await withDbRetry(
        () =>
          db
            .update(linkGraphTable)
            .set({ targetUrl: r.to })
            .where(eq(linkGraphTable.targetUrl, r.from)),
        { label: "link_graph rewrite target" },
      );
    }
    // Drop self-links produced by variant collapse.
    await withDbRetry(
      () =>
        db.execute(sql`DELETE FROM link_graph WHERE source_url = target_url`),
      { label: "link_graph drop self-links" },
    );
    logger.info(
      { deleted: toDelete.length, rewritten: toRewrite.length },
      "URL hygiene: link_graph done",
    );
  }

  // ---- 7. Rebuild link stats + PageRank on the cleaned graph.
  try {
    await recomputeStats();
  } catch (e) {
    logger.warn({ err: e }, "URL hygiene: recomputeStats failed");
  }

  // ---- 8. Seed the canonical pages registry from cleaned sources.
  {
    const wp = await db
      .select({ url: wpPostsTable.url, title: wpPostsTable.title })
      .from(wpPostsTable);
    for (const r of wp) {
      const p = canonicalPath(r.url);
      if (!p) continue;
      await withDbRetry(
        () =>
          db
            .insert(pagesTable)
            .values({
              path: p,
              url: canonicalUrl(p),
              title: r.title,
              section: sectionFor(r.url),
              inWp: true,
              inSitemap: true,
              httpStatus: 200,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: pagesTable.path,
              set: {
                title: r.title,
                section: sectionFor(r.url),
                inWp: true,
                inSitemap: true,
                updatedAt: new Date(),
              },
            }),
        { label: "pages seed from wp_posts" },
      );
    }
    const inv = await db.select().from(inventoryTable);
    for (const r of inv) {
      const p = canonicalPath(r.url);
      if (!p) continue;
      await withDbRetry(
        () =>
          db
            .insert(pagesTable)
            .values({
              path: p,
              url: canonicalUrl(p),
              title: r.title,
              section: sectionFor(r.url),
              inGsc: true,
              topQuery: r.topQuery,
              position: r.position,
              impressions: r.impressions,
              clicks: r.clicks,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: pagesTable.path,
              set: {
                inGsc: true,
                topQuery: r.topQuery,
                position: r.position,
                impressions: r.impressions,
                clicks: r.clicks,
                updatedAt: new Date(),
              },
            }),
        { label: "pages seed from inventory" },
      );
    }
    logger.info(
      { wp: wp.length, inventory: inv.length },
      "URL hygiene: pages registry seeded",
    );
  }

  logger.info("URL hygiene migration: done");
}
