import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Backlink prospecting: domains that link to competitors but not to us,
 * discovered via DataForSEO referring-domain pulls (user-initiated, cached),
 * with lightweight outreach status tracking.
 */
export const backlinkProspectsTable = pgTable(
  "backlink_prospects",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id),
    domain: text("domain").notNull(),
    /** DataForSEO domain rank (0-1000 scale), null when unknown. */
    rank: integer("rank"),
    /** Total backlinks this domain points at the competitor(s). */
    backlinks: integer("backlinks").notNull().default(0),
    /** Competitor domains this prospect links to. */
    competitorsLinking: jsonb("competitors_linking").notNull().default([]),
    /** Outreach status: new | contacted | replied | linked | rejected */
    status: text("status").notNull().default("new"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("backlink_prospects_site_domain_idx").on(t.siteId, t.domain),
    index("backlink_prospects_site_status_idx").on(t.siteId, t.status),
  ],
);
