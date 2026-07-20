import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export interface ClusterRunParams {
  /** GSC lookback window in days. */
  days: number;
  /** ISO 3166-1 alpha-3 country filter for GSC, or null for worldwide. */
  country: string | null;
  /** Max number of top queries (by impressions) to cluster. */
  keywordLimit: number;
  /** DataForSEO location_code for SERP scraping (e.g. 2840 = United States). */
  locationCode: number;
  /** Exclude queries containing the brand token. */
  excludeBrand: boolean;
}

export interface ClusterSerpUrl {
  url: string;
  position: number;
}

export interface ClusterKeywordEntry {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Top organic SERP URLs captured for this query (kept for debug/re-cluster). */
  serpUrls: ClusterSerpUrl[];
}

export interface ClusterUrlEntry {
  url: string;
  /** Registrable host of the URL (e.g. competitor.com). */
  domain: string;
  /** How many of the cluster's keywords this URL ranks for. */
  keywordCount: number;
  bestPosition: number | null;
  avgPosition: number | null;
}

export const clusterRunsTable = pgTable("cluster_runs", {
  id: serial("id").primaryKey(),
  /** queued | running | complete | failed | interrupted */
  status: text("status").notNull().default("queued"),
  phase: text("phase"),
  params: jsonb("params").$type<ClusterRunParams>().notNull(),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  stats: jsonb("stats").$type<Record<string, number>>().default({}),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
});

export const clusterRunClustersTable = pgTable(
  "cluster_run_clusters",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => clusterRunsTable.id, { onDelete: "cascade" }),
    /** Sequential cluster number within the run; -1 = unclustered keywords. */
    clusterKey: integer("cluster_key").notNull(),
    topic: text("topic").notNull(),
    /** opportunities | stars | niche | underperformers; null for unclustered. */
    quadrant: text("quadrant"),
    /** Outside the 20th–90th impressions percentile band (hidden from chart by default). */
    isOutlier: boolean("is_outlier").notNull().default(false),
    keywordCount: integer("keyword_count").notNull(),
    totalClicks: integer("total_clicks").notNull(),
    totalImpressions: integer("total_impressions").notNull(),
    /** Blended CTR as a percentage (0–100). */
    blendedCtr: real("blended_ctr").notNull(),
    avgPosition: real("avg_position"),
    keywords: jsonb("keywords").$type<ClusterKeywordEntry[]>().notNull(),
    ownUrls: jsonb("own_urls").$type<ClusterUrlEntry[]>().notNull().default([]),
    competitorUrls: jsonb("competitor_urls")
      .$type<ClusterUrlEntry[]>()
      .notNull()
      .default([]),
  },
  (t) => [index("cluster_run_clusters_run_idx").on(t.runId)],
);

export type ClusterRun = typeof clusterRunsTable.$inferSelect;
export type ClusterRunCluster = typeof clusterRunClustersTable.$inferSelect;
