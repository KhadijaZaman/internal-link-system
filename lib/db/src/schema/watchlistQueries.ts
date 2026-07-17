import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Operator-curated watchlist of search queries to keep an eye on. When a
 * watchlisted query shows up among a page's losers, the page rollup flags it so
 * the operator can prioritise it. Manually maintained (user-entered) — not
 * populated by any job.
 */
export const watchlistQueriesTable = pgTable("watchlist_queries", {
  id: serial("id").primaryKey(),
  query: text("query").notNull().unique(),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
});

export type WatchlistQuery = typeof watchlistQueriesTable.$inferSelect;
