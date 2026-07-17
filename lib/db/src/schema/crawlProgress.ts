import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

export const crawlProgressTable = pgTable("crawl_progress", {
  id: integer("id").primaryKey().default(1),
  lastOffset: integer("last_offset").default(0).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
});

export type CrawlProgress = typeof crawlProgressTable.$inferSelect;
