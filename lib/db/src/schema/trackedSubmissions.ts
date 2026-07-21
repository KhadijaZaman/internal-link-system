import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const trackedSubmissionsTable = pgTable("tracked_submissions", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id")
    .notNull()
    .default(1)
    .references(() => sitesTable.id),
  url: text("url").notNull(),
  keyword: text("keyword"),
  label: text("label"),
  note: text("note"),
  status: text("status").default("tracking").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type TrackedSubmission = typeof trackedSubmissionsTable.$inferSelect;
