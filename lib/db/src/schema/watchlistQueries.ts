import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  unique,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Operator-curated watchlist of search queries to keep an eye on. When a
 * watchlisted query shows up among a page's losers, the page rollup flags it so
 * the operator can prioritise it. Manually maintained (user-entered) — not
 * populated by any job.
 */
export const watchlistQueriesTable = pgTable(
  "watchlist_queries",
  {
    id: serial("id").primaryKey(),
    query: text("query").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    queryUniq: unique("watchlist_queries_query_unique").on(t.query, t.siteId),
  }),
);

export type WatchlistQuery = typeof watchlistQueriesTable.$inferSelect;
