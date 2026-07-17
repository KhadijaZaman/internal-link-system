import { pgTable, serial, integer, date, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily site-health score snapshots, persisted at the end of every
 * recompute_action_queue run (one row per day, re-runs overwrite).
 * `components` stores the raw counts and normalized 0-1 penalty inputs so
 * historical scores stay explainable after the live signals move on.
 */
export const healthSnapshotsTable = pgTable(
  "health_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date").notNull(),
    score: integer("score").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("health_snapshots_date_uniq").on(t.snapshotDate),
  }),
);

export type HealthSnapshot = typeof healthSnapshotsTable.$inferSelect;
