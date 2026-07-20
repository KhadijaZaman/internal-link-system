import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Non-content paths excluded from every ingestion path and metric view.
// Patterns use `*` as the only wildcard and are matched against the
// canonical path (see api-server lib/urlCanon.ts). Rows with source
// "crawler-404" are added automatically when the crawler sees a 404.
export const urlBlocklistTable = pgTable("url_blocklist", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull().unique(),
  note: text("note"),
  source: text("source").notNull().default("manual"), // "seed" | "manual" | "crawler-404"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type UrlBlocklistRow = typeof urlBlocklistTable.$inferSelect;
