import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
  uniqueIndex,
  doublePrecision,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Where on the page the link was extracted from.
 *  - "content": inside <article>/<main>/the body of the post. The ONLY
 *    placement that counts toward internal-linking decisions (orphans,
 *    over-linked thresholds, suggestion engine).
 *  - "nav" | "header" | "footer": structural chrome. Stored for reporting
 *    (so we can show "X content + Y chrome" breakdowns) but excluded from
 *    the linking pipeline.
 */
export const linkGraphTable = pgTable(
  "link_graph",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    anchorText: text("anchor_text"),
    surroundingText: text("surrounding_text"),
    placement: text("placement").notNull().default("content"),
    crawledAt: timestamp("crawled_at", { withTimezone: true }).defaultNow(),
    // Link-quality audit (audit_link_quality job; content edges only).
    // NULL = not audited yet (new edges after a re-crawl stay NULL until the
    // next audit run). auditSimilarity is source→target embedding cosine
    // (NULL when either page has no embedding).
    auditSimilarity: doublePrecision("audit_similarity"),
    auditFlags: jsonb("audit_flags").$type<string[]>(),
    auditedAt: timestamp("audited_at", { withTimezone: true }),
  },
  (t) => ({
    sourceIdx: index("link_graph_source_idx").on(t.sourceUrl),
    targetIdx: index("link_graph_target_idx").on(t.targetUrl),
    placementIdx: index("link_graph_placement_idx").on(t.placement),
    uniq: uniqueIndex("link_graph_uniq").on(
      t.siteId,
      t.sourceUrl,
      t.targetUrl,
      t.anchorText,
    ),
  }),
);

export type LinkGraphRow = typeof linkGraphTable.$inferSelect;
