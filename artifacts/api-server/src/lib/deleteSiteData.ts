import {
  db,
  actionItemsTable,
  aiCitationUploadsTable,
  appStateTable,
  auditReportsTable,
  bingPageStatsTable,
  bingQueryStatsTable,
  clusterRunsTable,
  conversations,
  crawlProgressTable,
  digestsTable,
  gscSnapshotsTable,
  healthSnapshotsTable,
  inventoryTable,
  jobRunsTable,
  kbDocumentsTable,
  linkExcludeListTable,
  linkGraphTable,
  linkingSettingsTable,
  linkLookupsTable,
  linkStatsTable,
  linkSuggestionsTable,
  optimizeQueueTable,
  pageClassificationsTable,
  pagesTable,
  pageTargetKeywordsTable,
  queryIntelTable,
  queryLosersTable,
  similarityRunsTable,
  siteIntegrationsTable,
  sitesTable,
  topicalMapsTable,
  trackedSubmissionsTable,
  urlBlocklistTable,
  watchlistQueriesTable,
  wpPostsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { invalidateSiteCache } from "./site";
import { invalidateIntegrationCache } from "./siteIntegrations";

/**
 * Permanently delete a site and every row it owns, in one transaction.
 *
 * Only "parent" tables are listed here — child tables (messages, kb_chunks,
 * ai_citation_rows, cluster_run_clusters, topical_map_nodes/bridges) all
 * declare ON DELETE CASCADE from their parent, so deleting the parent rows
 * removes them. Every table below carries its own site_id FK to sites.
 *
 * Callers are responsible for authorization (owner-only) and for refusing
 * to delete the legacy site — this helper just executes.
 */
export async function deleteSiteData(siteId: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Site-scoped parent tables, no particular order required (no FKs
    // between them — only child→parent cascades handled by Postgres).
    await tx.delete(conversations).where(eq(conversations.siteId, siteId));
    await tx.delete(aiCitationUploadsTable).where(eq(aiCitationUploadsTable.siteId, siteId));
    await tx.delete(kbDocumentsTable).where(eq(kbDocumentsTable.siteId, siteId));
    await tx.delete(clusterRunsTable).where(eq(clusterRunsTable.siteId, siteId));
    await tx.delete(topicalMapsTable).where(eq(topicalMapsTable.siteId, siteId));
    await tx.delete(similarityRunsTable).where(eq(similarityRunsTable.siteId, siteId));
    await tx.delete(linkGraphTable).where(eq(linkGraphTable.siteId, siteId));
    await tx.delete(linkSuggestionsTable).where(eq(linkSuggestionsTable.siteId, siteId));
    await tx.delete(gscSnapshotsTable).where(eq(gscSnapshotsTable.siteId, siteId));
    await tx.delete(queryLosersTable).where(eq(queryLosersTable.siteId, siteId));
    await tx.delete(optimizeQueueTable).where(eq(optimizeQueueTable.siteId, siteId));
    await tx.delete(auditReportsTable).where(eq(auditReportsTable.siteId, siteId));
    await tx.delete(linkLookupsTable).where(eq(linkLookupsTable.siteId, siteId));
    await tx.delete(trackedSubmissionsTable).where(eq(trackedSubmissionsTable.siteId, siteId));
    await tx.delete(actionItemsTable).where(eq(actionItemsTable.siteId, siteId));
    await tx.delete(healthSnapshotsTable).where(eq(healthSnapshotsTable.siteId, siteId));
    await tx.delete(digestsTable).where(eq(digestsTable.siteId, siteId));
    await tx.delete(bingPageStatsTable).where(eq(bingPageStatsTable.siteId, siteId));
    await tx.delete(bingQueryStatsTable).where(eq(bingQueryStatsTable.siteId, siteId));
    await tx.delete(inventoryTable).where(eq(inventoryTable.siteId, siteId));
    await tx.delete(linkStatsTable).where(eq(linkStatsTable.siteId, siteId));
    await tx.delete(crawlProgressTable).where(eq(crawlProgressTable.siteId, siteId));
    await tx.delete(linkingSettingsTable).where(eq(linkingSettingsTable.siteId, siteId));
    await tx.delete(pageClassificationsTable).where(eq(pageClassificationsTable.siteId, siteId));
    await tx.delete(wpPostsTable).where(eq(wpPostsTable.siteId, siteId));
    await tx.delete(queryIntelTable).where(eq(queryIntelTable.siteId, siteId));
    await tx.delete(pageTargetKeywordsTable).where(eq(pageTargetKeywordsTable.siteId, siteId));
    await tx.delete(pagesTable).where(eq(pagesTable.siteId, siteId));
    await tx.delete(linkExcludeListTable).where(eq(linkExcludeListTable.siteId, siteId));
    await tx.delete(urlBlocklistTable).where(eq(urlBlocklistTable.siteId, siteId));
    await tx.delete(watchlistQueriesTable).where(eq(watchlistQueriesTable.siteId, siteId));
    await tx.delete(jobRunsTable).where(eq(jobRunsTable.siteId, siteId));
    await tx.delete(siteIntegrationsTable).where(eq(siteIntegrationsTable.siteId, siteId));
    // Per-site app_state entries (e.g. the keyword movement spreadsheet id).
    await tx
      .delete(appStateTable)
      .where(eq(appStateTable.key, `keyword_movement_sheet_id:${siteId}`));
    await tx.delete(sitesTable).where(eq(sitesTable.id, siteId));
  });
  invalidateSiteCache(siteId);
  invalidateIntegrationCache(siteId);
}
