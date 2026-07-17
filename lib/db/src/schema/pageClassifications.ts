import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

export const pageClassificationsTable = pgTable("page_classifications", {
  url: text("url").primaryKey(),
  tier: integer("tier"), // 1..4
  centralEntity: text("central_entity"),
  subEntity: text("sub_entity"),
  parentRootUrl: text("parent_root_url"),
  canonicalQuery: text("canonical_query"),
  anchorVariants: jsonb("anchor_variants").$type<string[]>().default([]),
  linkQuotaMin: integer("link_quota_min").default(0),
  linkQuotaMax: integer("link_quota_max").default(0),
  topicalBordersMatch: boolean("topical_borders_match").default(true),
  manuallyEdited: boolean("manually_edited").default(false),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow(),
});

export type PageClassification = typeof pageClassificationsTable.$inferSelect;
