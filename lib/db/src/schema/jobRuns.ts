import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const jobRunsTable = pgTable(
  "job_runs",
  {
    name: text("name").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastDurationMs: integer("last_duration_ms"),
    lastError: text("last_error"),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
  },
  (t) => ({
    pk: primaryKey({
      name: "job_runs_pkey",
      columns: [t.name, t.siteId],
    }),
  }),
);

export type JobRun = typeof jobRunsTable.$inferSelect;
