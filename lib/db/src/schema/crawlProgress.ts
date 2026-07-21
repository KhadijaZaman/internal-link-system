import { pgTable, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

// One row per site (id is always 1 within a site).
export const crawlProgressTable = pgTable(
  "crawl_progress",
  {
    id: integer("id").notNull().default(1),
    lastOffset: integer("last_offset").default(0).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({ name: "crawl_progress_pkey", columns: [t.id, t.siteId] }),
  }),
);

export type CrawlProgress = typeof crawlProgressTable.$inferSelect;
