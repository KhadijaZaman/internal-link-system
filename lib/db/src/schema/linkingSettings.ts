import {
  pgTable,
  integer,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

// One row per site (id is always 1 within a site).
export const linkingSettingsTable = pgTable(
  "linking_settings",
  {
    id: integer("id").notNull().default(1),
    similarityThreshold: doublePrecision("similarity_threshold").default(0.65).notNull(),
    densityMinPer1000: doublePrecision("density_min_per_1000").default(2).notNull(),
    densityMaxPer1000: doublePrecision("density_max_per_1000").default(4).notNull(),
    hubDensityMaxPer1000: doublePrecision("hub_density_max_per_1000").default(8).notNull(),
    moneyDensityMaxPer1000: doublePrecision("money_density_max_per_1000").default(2).notNull(),
    shortPageMaxLinks: integer("short_page_max_links").default(2).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({ name: "linking_settings_pkey", columns: [t.id, t.siteId] }),
  }),
);

export type LinkingSettings = typeof linkingSettingsTable.$inferSelect;
