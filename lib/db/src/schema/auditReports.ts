import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

export const auditReportsTable = pgTable(
  "audit_reports",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    type: text("type").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    payload: jsonb("payload").$type<unknown>().default([]),
  },
  (t) => ({
    typeIdx: index("audit_reports_type_idx").on(t.type, t.runAt),
  }),
);

export type AuditReport = typeof auditReportsTable.$inferSelect;
