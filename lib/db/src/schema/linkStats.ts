import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const linkStatsTable = pgTable(
  "link_stats",
  {
    url: text("url").notNull(),
    inboundCount: integer("inbound_count").default(0).notNull(),
    outboundCount: integer("outbound_count").default(0).notNull(),
    internalPagerank: doublePrecision("internal_pagerank").default(0).notNull(),
    isOrphan: boolean("is_orphan").default(false).notNull(),
    isDeadEnd: boolean("is_dead_end").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({ name: "link_stats_pkey", columns: [t.url, t.siteId] }),
  }),
);

export type LinkStats = typeof linkStatsTable.$inferSelect;
