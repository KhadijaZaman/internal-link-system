import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const trackedSubmissionsTable = pgTable("tracked_submissions", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  keyword: text("keyword"),
  label: text("label"),
  note: text("note"),
  status: text("status").default("tracking").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type TrackedSubmission = typeof trackedSubmissionsTable.$inferSelect;
