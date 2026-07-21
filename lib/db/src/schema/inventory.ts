import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const inventoryTable = pgTable(
  "inventory",
  {
    url: text("url").notNull(),
    title: text("title"),
    h1: text("h1"),
    section: text("section"),
    topQuery: text("top_query"),
    position: doublePrecision("position"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({ name: "inventory_pkey", columns: [t.url, t.siteId] }),
  }),
);

export type Inventory = typeof inventoryTable.$inferSelect;
