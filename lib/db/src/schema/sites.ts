import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Site registry — the multi-tenant root. Every per-site table carries a
 * site_id FK to this table. `ownerUserId` is null only for the migrated
 * legacy site until the operator claims it via POST /api/sites/claim-legacy.
 *
 * `host` is the bare hostname (no scheme, no www) used by URL
 * canonicalization; `domain` preserves what the user entered.
 */
export const sitesTable = pgTable(
  "sites",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").references(() => usersTable.id),
    domain: text("domain").notNull(),
    host: text("host").notNull(), // canonical bare host, e.g. "wellows.com"
    displayName: text("display_name").notNull(),
    sitemapUrl: text("sitemap_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hostUniq: uniqueIndex("sites_host_uniq").on(t.host),
  }),
);

export type SiteRow = typeof sitesTable.$inferSelect;
