import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Cached DataForSEO backlink-audit payloads, persisted so paid pulls survive
 * server restarts. One row per (site, target domain, kind).
 *
 * kind: "summary" | "anchors" | "backlinks" | "referring_domains"
 * payload: raw normalized JSON from the integration layer.
 */
export const backlinkAuditsTable = pgTable(
  "backlink_audits",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("backlink_audits_site_target_kind_idx").on(t.siteId, t.target, t.kind)],
);
