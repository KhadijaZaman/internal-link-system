import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Local mirror of Clerk users. Rows are provisioned just-in-time on the
 * first authenticated request (see api-server lib/auth.ts) — the id IS the
 * Clerk user id. Profile fields live in Clerk; this table exists so that
 * sites (and future per-user rows) have a real FK target.
 */
export const usersTable = pgTable("users", {
  id: text("id").primaryKey(), // Clerk user id, e.g. "user_2..."
  // Platform admin (operator). Bootstrapped at server startup: if no admin
  // exists yet, the owner of the legacy site (id 1) becomes admin.
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
