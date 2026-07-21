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

export const gscSnapshotsTable = pgTable(
  "gsc_snapshots",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    snapshotDate: date("snapshot_date").notNull(),
    url: text("url").notNull(),
    query: text("query").notNull(),
    position: doublePrecision("position"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    ctr: doublePrecision("ctr"),
  },
  (t) => ({
    byDateUrl: index("gsc_snapshots_date_url_idx").on(t.snapshotDate, t.url),
    byUrlQuery: index("gsc_snapshots_url_query_idx").on(t.url, t.query),
  }),
);

export type GscSnapshot = typeof gscSnapshotsTable.$inferSelect;
