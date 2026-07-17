import { pgTable, integer, doublePrecision, timestamp } from "drizzle-orm/pg-core";

export const linkingSettingsTable = pgTable("linking_settings", {
  id: integer("id").primaryKey().default(1),
  similarityThreshold: doublePrecision("similarity_threshold").default(0.65).notNull(),
  densityMinPer1000: doublePrecision("density_min_per_1000").default(2).notNull(),
  densityMaxPer1000: doublePrecision("density_max_per_1000").default(4).notNull(),
  hubDensityMaxPer1000: doublePrecision("hub_density_max_per_1000").default(8).notNull(),
  moneyDensityMaxPer1000: doublePrecision("money_density_max_per_1000").default(2).notNull(),
  shortPageMaxLinks: integer("short_page_max_links").default(2).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type LinkingSettings = typeof linkingSettingsTable.$inferSelect;
