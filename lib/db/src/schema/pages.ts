import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Canonical page registry — ONE row per canonical path. Every ingestion
// path (GSC sync, crawler, WordPress sync) upserts here, and every view
// counts pages from this table with an explicit filter. Metrics tables
// (gsc_snapshots, wp_posts, link_graph) keep their own rows but store
// canonical URLs so they join cleanly against this registry.
export const pagesTable = pgTable(
  "pages",
  {
    path: text("path").primaryKey(), // canonical path, e.g. "/blog/ai-startups"
    url: text("url").notNull(), // canonical absolute URL
    title: text("title"),
    section: text("section"),
    // Source flags: which system knows about this page.
    inWp: boolean("in_wp").notNull().default(false),
    inGsc: boolean("in_gsc").notNull().default(false),
    inSitemap: boolean("in_sitemap").notNull().default(false),
    // Last HTTP status the crawler observed (null = never fetched).
    httpStatus: integer("http_status"),
    // GSC rollups for the page (top query by impressions, latest sync).
    topQuery: text("top_query"),
    position: doublePrecision("position"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    // GA4 rollups (28-day rolling window, all channels, latest sync_ga4_pages
    // run). keyEvents = signups + demo bookings landed on this page.
    keyEvents: integer("key_events"),
    aiSessions: integer("ai_sessions"),
    ga4SyncedAt: timestamp("ga4_synced_at", { withTimezone: true }),
    // Bing rollups (~6-month window summed, latest sync_bing_pages run).
    bingClicks: integer("bing_clicks"),
    bingImpressions: integer("bing_impressions"),
    bingPosition: doublePrecision("bing_position"),
    bingSyncedAt: timestamp("bing_synced_at", { withTimezone: true }),
    // AI citation rollup from the NEWEST "pages"-kind AI Performance upload.
    aiCitations: integer("ai_citations"),
    aiCitationsAt: timestamp("ai_citations_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    sectionIdx: index("pages_section_idx").on(t.section),
  }),
);

export type PageRow = typeof pagesTable.$inferSelect;
