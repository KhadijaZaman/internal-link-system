import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Unified "do this next" queue. Rows are materialized from live signals
 * (orphans, dead-ends, query losers, pending link suggestions, optimize
 * queue) by the recompute_action_queue job, which reconciles by dedupe_key:
 * upserts open items, auto-closes items whose source signal disappeared,
 * and never resurrects dismissed rows.
 */
export const actionItemsTable = pgTable(
  "action_items",
  {
    id: serial("id").primaryKey(),
    /** action_type + normalized target URL — stable identity across recomputes. */
    dedupeKey: text("dedupe_key").notNull(),
    actionType: text("action_type").notNull(),
    targetUrl: text("target_url").notNull(),
    title: text("title"),
    description: text("description"),
    score: doublePrecision("score").default(0).notNull(),
    impressionsAtStake: integer("impressions_at_stake").default(0).notNull(),
    clicksAtStake: integer("clicks_at_stake").default(0).notNull(),
    /** Type-specific detail (severity, suggestion count, top query, ...). */
    source: jsonb("source").$type<Record<string, unknown>>().default({}),
    /** open | done | dismissed */
    status: text("status").default("open").notNull(),
    /** How a non-open row got there: manual (admin click) | auto (signal resolved). */
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("action_items_dedupe_uniq").on(t.dedupeKey),
  }),
);

export type ActionItem = typeof actionItemsTable.$inferSelect;
