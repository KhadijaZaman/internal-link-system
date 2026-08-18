import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Persisted per-site disavow decisions.
 *
 * decision: "disavow" | "keep"
 *   disavow — user explicitly wants to disavow this domain
 *   keep    — user reviewed it and decided to keep it (won't appear in export)
 *
 * Decisions accumulate across audit refreshes. The export always reflects
 * the current persisted set regardless of whether the domain still appears
 * in the live referring-domains list.
 */
export const backlinkDisavowTable = pgTable(
  "backlink_disavow",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    decision: text("decision").notNull(), // "disavow" | "keep"
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("backlink_disavow_site_domain_idx").on(t.siteId, t.domain)],
);
