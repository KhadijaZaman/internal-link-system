import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  unique,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const linkExcludeListTable = pgTable(
  "link_exclude_list",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    patternUniq: unique("link_exclude_list_pattern_unique").on(
      t.pattern,
      t.siteId,
    ),
  }),
);

export type LinkExcludeRow = typeof linkExcludeListTable.$inferSelect;
