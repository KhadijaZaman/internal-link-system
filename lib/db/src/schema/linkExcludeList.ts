import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const linkExcludeListTable = pgTable("link_exclude_list", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull().unique(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type LinkExcludeRow = typeof linkExcludeListTable.$inferSelect;
