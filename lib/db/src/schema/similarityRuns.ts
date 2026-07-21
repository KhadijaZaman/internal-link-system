import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export interface SimilarityArticleSimilar {
  /** Input URL of the similar article. */
  url: string;
  title: string | null;
  /** Cosine similarity (0–1, rounded to 3 decimals). */
  sim: number;
}

export interface SimilarityArticleResult {
  /** URL as entered by the user (post-normalization). */
  url: string;
  /** URL after redirects, when the fetch succeeded. */
  finalUrl: string | null;
  title: string | null;
  wordCount: number | null;
  /** Key topics extracted by the model (empty when analysis failed). */
  topics: string[];
  mainTheme: string | null;
  /** Per-article failure (fetch/embed error) — other articles still analyze. */
  error: string | null;
  /** Other articles ranked by cosine similarity, highest first. */
  similar: SimilarityArticleSimilar[];
}

export interface SimilarityClusterResult {
  label: string;
  /** Input URLs of member articles. */
  memberUrls: string[];
}

export interface SimilarityResults {
  articles: SimilarityArticleResult[];
  clusters: SimilarityClusterResult[];
}

export const similarityRunsTable = pgTable("similarity_runs", {
  id: serial("id").primaryKey(),
  /** queued | running | complete | failed | interrupted */
  status: text("status").notNull().default("queued"),
  /** Normalized input URLs (deduped, max 100). */
  urls: jsonb("urls").$type<string[]>().notNull(),
  /** Full analysis payload; null until the run completes. */
  results: jsonb("results").$type<SimilarityResults>(),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
});

export type SimilarityRun = typeof similarityRunsTable.$inferSelect;
