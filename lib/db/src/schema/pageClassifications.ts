import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const pageClassificationsTable = pgTable(
  "page_classifications",
  {
    url: text("url").notNull(),
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
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({
      name: "page_classifications_pkey",
      columns: [t.url, t.siteId],
    }),
  }),
);

export type PageClassification = typeof pageClassificationsTable.$inferSelect;
