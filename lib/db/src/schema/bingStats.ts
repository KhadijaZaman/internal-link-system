import {
  pgTable,
  serial,
  text,
  doublePrecision,
  integer,
  date,
  index,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

// Bing Webmaster API time series (sync_bing_pages job). The API returns a
// rolling ~6-month window with no date params, so every sync is a
// transactional delete-all + reinsert. Rows are keyed by the week-ish bucket
// date Bing reports. URLs are canonicalized before insert; rows that collapse
// onto one canonical path are merged (summed clicks/impressions,
// impression-weighted position).
export const bingPageStatsTable = pgTable(
  "bing_page_stats",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    bucketDate: date("bucket_date").notNull(),
    path: text("path").notNull(), // canonical path
    clicks: integer("clicks").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    position: doublePrecision("position"), // avg impression position (null when Bing reports -1)
  },
  (t) => ({
    byDatePath: index("bing_page_stats_date_path_idx").on(t.bucketDate, t.path),
    byPath: index("bing_page_stats_path_idx").on(t.path),
  }),
);

export const bingQueryStatsTable = pgTable(
  "bing_query_stats",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    bucketDate: date("bucket_date").notNull(),
    query: text("query").notNull(),
    clicks: integer("clicks").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    position: doublePrecision("position"),
  },
  (t) => ({
    byDateQuery: index("bing_query_stats_date_query_idx").on(
      t.bucketDate,
      t.query,
    ),
    byQuery: index("bing_query_stats_query_idx").on(t.query),
  }),
);

export type BingPageStat = typeof bingPageStatsTable.$inferSelect;
export type BingQueryStat = typeof bingQueryStatsTable.$inferSelect;
