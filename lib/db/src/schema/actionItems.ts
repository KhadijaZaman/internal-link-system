import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  date,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

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
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
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
    /** Stable workspace grouping: content | linking | technical | visibility | authority. */
    category: text("category").default("technical").notNull(),
    /** Canonical, human-readable source records retained alongside the summary source payload. */
    sourceRecords: jsonb("source_records")
      .$type<Array<{ kind: string; label: string; url?: string; observedAt?: string; data?: Record<string, unknown> }>>()
      .default([])
      .notNull(),
    /** Explainable score inputs; score remains the sortable aggregate. */
    scoreComponents: jsonb("score_components")
      .$type<Record<string, number | string | null>>()
      .default({})
      .notNull(),
    owner: text("owner"),
    dueDate: date("due_date", { mode: "string" }),
    market: text("market").default("global").notNull(),
    /** fresh | stale | missing */
    freshness: text("freshness").default("fresh").notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    /** Optimistic-lock token used by governed spreadsheet and batch updates. */
    version: integer("version").default(1).notNull(),
    /** open | done | dismissed */
    status: text("status").default("open").notNull(),
    /** How a non-open row got there: manual (admin click) | auto (signal resolved). */
    resolution: text("resolution"),
    /**
     * Set when the operator manually reopens an item. Pinned-open rows are
     * exempt from auto-close on recompute — only a manual Done/Dismiss (which
     * clears the pin) closes them.
     */
    pinnedOpen: boolean("pinned_open").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("action_items_dedupe_uniq").on(t.siteId, t.dedupeKey),
  }),
);

export type ActionItem = typeof actionItemsTable.$inferSelect;
