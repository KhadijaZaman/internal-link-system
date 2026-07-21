import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * A knowledge-base passage that was injected into a brief's prompt as
 * grounding context. Stored on the optimize_queue row alongside the brief so
 * the operator can see exactly which source material shaped it.
 */
export interface GroundingPassage {
  documentId: number;
  documentTitle: string;
  chunkIndex: number;
  /** Cosine similarity between the brief's query embedding and this chunk. */
  score: number;
  /** First ~300 chars of the injected passage. */
  excerpt: string;
}

export const optimizeQueueTable = pgTable("optimize_queue", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id")
    .notNull()
    .default(1)
    .references(() => sitesTable.id),
  url: text("url").notNull(),
  status: text("status").default("optimize").notNull(),
  priority: text("priority").default("medium").notNull(),
  notes: text("notes"),
  briefMarkdown: text("brief_markdown"),
  // null = brief predates grounding capture (show nothing);
  // [] = brief generated with no KB grounding (show explicit note).
  groundingPassages: jsonb("grounding_passages").$type<GroundingPassage[]>(),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type OptimizeQueueItem = typeof optimizeQueueTable.$inferSelect;
