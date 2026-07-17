import { pgTable, serial, date, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Weekly digest snapshots — one row per ISO week (Monday date), written by
 * the weekly_digest job every Friday. `payload` is the fully rendered digest
 * content (new issues, completed work, impact wins, health score change) so
 * past digests stay stable even after the live data moves on.
 */
export const digestsTable = pgTable(
  "digests",
  {
    id: serial("id").primaryKey(),
    weekOf: date("week_of").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("digests_week_uniq").on(t.weekOf),
  }),
);

export type Digest = typeof digestsTable.$inferSelect;
