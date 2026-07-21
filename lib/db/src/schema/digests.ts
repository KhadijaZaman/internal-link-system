import {
  pgTable,
  serial,
  date,
  jsonb,
  timestamp,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

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
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    weekOf: date("week_of").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("digests_week_uniq").on(t.siteId, t.weekOf),
  }),
);

export type Digest = typeof digestsTable.$inferSelect;
