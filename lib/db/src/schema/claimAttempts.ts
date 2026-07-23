import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable rate-limit counters for the one-time legacy-site claim endpoint.
 * Rows are keyed by budget scope (per user|ip, per ip, global) and survive
 * server restarts / Autoscale instance recycling, unlike in-memory maps.
 */
export const claimAttemptsTable = pgTable("claim_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export type ClaimAttempt = typeof claimAttemptsTable.$inferSelect;
