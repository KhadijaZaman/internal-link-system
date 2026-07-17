import {
  pgTable,
  serial,
  text,
  doublePrecision,
  integer,
  date,
} from "drizzle-orm/pg-core";

export const queryLosersTable = pgTable("query_losers", {
  id: serial("id").primaryKey(),
  weekOf: date("week_of").notNull(),
  url: text("url").notNull(),
  query: text("query").notNull(),
  prevPosition: doublePrecision("prev_position"),
  currPosition: doublePrecision("curr_position"),
  positionChange: doublePrecision("position_change"),
  prevImpressions: integer("prev_impressions"),
  currImpressions: integer("curr_impressions"),
  impressionsChangePct: doublePrecision("impressions_change_pct"),
  severity: text("severity"),
});

export type QueryLoser = typeof queryLosersTable.$inferSelect;
