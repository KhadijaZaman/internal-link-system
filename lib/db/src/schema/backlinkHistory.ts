import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * One row per (site, date) capturing key backlink health metrics from each
 * audit run. Used for the authority / referring-domain growth sparkline.
 *
 * date is stored as a YYYY-MM-DD text value (UTC) so each calendar day
 * produces exactly one upserted row per site.
 */
export const backlinkHistoryTable = pgTable(
  "backlink_history",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (UTC) */
    date: text("date").notNull(),
    /** DataForSEO domain rank (0–1000, comparable to Ahrefs DR) */
    rank: integer("rank"),
    backlinks: integer("backlinks"),
    referringDomains: integer("referring_domains"),
    dofollow: integer("dofollow"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("backlink_history_site_date_idx").on(t.siteId, t.date)],
);
