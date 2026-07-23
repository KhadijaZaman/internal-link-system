import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Per-site data-source connections (GSC OAuth refresh token, GA4 service
 * account, Bing API key). One row per (site, provider). `credentials` holds
 * the secret material and must NEVER be returned by any API response —
 * routes expose only a connected/not-connected status plus non-secret
 * config (e.g. the selected GSC property).
 *
 * The legacy site (id 1) may have no rows here — integration code falls
 * back to the historical GSC_* / GA4_* / BING_* env vars for that site
 * only.
 */
export const siteIntegrationsTable = pgTable(
  "site_integrations",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id, { onDelete: "cascade" }),
    /** "gsc" | "ga4" | "bing" */
    provider: text("provider").notNull(),
    /** Secret material (refresh token / service-account JSON / API key). */
    credentials: jsonb("credentials").notNull(),
    /** Non-secret settings (e.g. GSC property, GA4 property id). */
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteProviderUniq: uniqueIndex("site_integrations_site_provider_uniq").on(
      t.siteId,
      t.provider,
    ),
  }),
);

export type SiteIntegrationRow = typeof siteIntegrationsTable.$inferSelect;
