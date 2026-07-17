import {
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Operator-entered target keywords for a specific page (URL). These feed the
 * optimizer brief generator: when a page is queued, its target keywords are
 * passed into the brief so the canonical "primary target query" reflects the
 * operator's intent rather than only the highest-impression GSC query.
 * Manually maintained (user-entered) — not populated by any job.
 */
export const pageTargetKeywordsTable = pgTable(
  "page_target_keywords",
  {
    id: serial("id").primaryKey(),
    url: text("url").notNull(),
    keyword: text("keyword").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    urlKeywordUnique: unique("page_target_keywords_url_keyword_unique").on(
      t.url,
      t.keyword,
    ),
  }),
);

export type PageTargetKeyword = typeof pageTargetKeywordsTable.$inferSelect;
