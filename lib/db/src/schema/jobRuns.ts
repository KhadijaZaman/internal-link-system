import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const jobRunsTable = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastDurationMs: integer("last_duration_ms"),
  lastError: text("last_error"),
});

export type JobRun = typeof jobRunsTable.$inferSelect;
