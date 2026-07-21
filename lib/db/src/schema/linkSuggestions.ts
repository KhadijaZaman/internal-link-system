import {
  pgTable,
  serial,
  text,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const linkSuggestionsTable = pgTable(
  "link_suggestions",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    donorUrl: text("donor_url").notNull(),
    receiverUrl: text("receiver_url").notNull(),
    anchorText: text("anchor_text"),
    korayRationale: text("koray_rationale"),
    sectionLinkType: text("section_link_type"),
    insertionSentence: text("insertion_sentence"),
    priorityScore: doublePrecision("priority_score"),
    status: text("status").default("pending_review").notNull(),
    suggestedAt: timestamp("suggested_at", { withTimezone: true }).defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    engineVersion: text("engine_version").default("legacy-v0").notNull(),
    tierPair: text("tier_pair"),
    similarityScore: doublePrecision("similarity_score"),
    authorityScore: doublePrecision("authority_score"),
    anchorFitScore: doublePrecision("anchor_fit_score"),
    freshnessScore: doublePrecision("freshness_score"),
    anchorVariants: jsonb("anchor_variants").$type<string[]>().default([]),
    placementHint: text("placement_hint"),
  },
  (t) => ({
    uniq: uniqueIndex("link_suggestions_uniq").on(
      t.siteId,
      t.donorUrl,
      t.receiverUrl,
      t.anchorText,
    ),
  }),
);

export type LinkSuggestion = typeof linkSuggestionsTable.$inferSelect;
