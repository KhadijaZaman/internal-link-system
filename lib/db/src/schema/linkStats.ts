import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const linkStatsTable = pgTable("link_stats", {
  url: text("url").primaryKey(),
  inboundCount: integer("inbound_count").default(0).notNull(),
  outboundCount: integer("outbound_count").default(0).notNull(),
  internalPagerank: doublePrecision("internal_pagerank").default(0).notNull(),
  isOrphan: boolean("is_orphan").default(false).notNull(),
  isDeadEnd: boolean("is_dead_end").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type LinkStats = typeof linkStatsTable.$inferSelect;
