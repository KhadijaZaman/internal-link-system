import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  index,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Original data research: each run mines the site's own stored data
 * (GSC pulls, crawl inventory, AI-citation uploads, publish dates) into
 * citation-ready statistics nobody else has published. Deterministic and
 * cost-safe — no paid APIs beyond the normal cached GSC reads.
 */
export const researchRunsTable = pgTable(
  "research_runs",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id),
    status: text("status").notNull().default("running"), // running | complete | error
    error: text("error"),
    /** GSC window the stats were computed over. */
    windowStart: text("window_start"),
    windowEnd: text("window_end"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("research_runs_site_idx").on(t.siteId, t.startedAt)],
);

export const researchFindingsTable = pgTable(
  "research_findings",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id),
    runId: integer("run_id")
      .notNull()
      .references(() => researchRunsTable.id, { onDelete: "cascade" }),
    /** Stable analysis identifier, e.g. ctr_curve, ai_agent_queries. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** The headline number, formatted (e.g. "38.2%"). */
    headlineStat: text("headline_stat").notNull(),
    headlineValue: real("headline_value"),
    /** One citation-ready sentence including the stat and sample size. */
    citation: text("citation").notNull(),
    /** How the number was computed — dataset, window, filters. */
    methodology: text("methodology").notNull(),
    /** Supporting series/breakdown for rendering charts or tables. */
    detail: jsonb("detail").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("research_findings_run_idx").on(t.runId)],
);

export type ResearchRun = typeof researchRunsTable.$inferSelect;
export type ResearchFinding = typeof researchFindingsTable.$inferSelect;
