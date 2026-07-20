import { sql } from "drizzle-orm";
import { db, pagesTable } from "@workspace/db";
import { isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";

/**
 * The ONE shared definition of a "content page" used by every header count
 * (Dashboard, Knowledge Graph, Site Authority). Reads from the canonical
 * `pages` registry: a page counts when at least one source (WordPress,
 * sitemap crawl, Search Console) knows it and it is not an error page.
 * Blocklisted paths never enter `pages`, so they are excluded by construction.
 */
export const CONTENT_PAGES_FILTER_LABEL =
  "Content pages: seen in WordPress, sitemap, or Search Console · status < 400 · blocklist excluded";

const contentPagesWhere = sql`(${pagesTable.inWp} = true OR ${pagesTable.inGsc} = true OR ${pagesTable.inSitemap} = true) AND coalesce(${pagesTable.httpStatus}, 200) < 400`;

export async function countContentPages(): Promise<number> {
  // The blocklist is applied in JS (patterns are wildcards, not SQL-friendly)
  // so patterns added AFTER a page was registered still drop it from counts.
  const [rows, block] = await Promise.all([
    db.select({ path: pagesTable.path }).from(pagesTable).where(contentPagesWhere),
    loadBlockRegexes(),
  ]);
  return rows.filter((r) => !isBlockedPath(r.path, block)).length;
}
