import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tiny key/value store for singleton app state that doesn't warrant its own
 * table (e.g. the persistent "Target Keyword Daily Movement" spreadsheet id).
 */
export const appStateTable = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AppState = typeof appStateTable.$inferSelect;
