import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const optimizeQueueTable = pgTable("optimize_queue", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").default("optimize").notNull(),
  priority: text("priority").default("medium").notNull(),
  notes: text("notes"),
  briefMarkdown: text("brief_markdown"),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type OptimizeQueueItem = typeof optimizeQueueTable.$inferSelect;
