import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const inventoryTable = pgTable("inventory", {
  url: text("url").primaryKey(),
  title: text("title"),
  h1: text("h1"),
  section: text("section"),
  topQuery: text("top_query"),
  position: doublePrecision("position"),
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export type Inventory = typeof inventoryTable.$inferSelect;
