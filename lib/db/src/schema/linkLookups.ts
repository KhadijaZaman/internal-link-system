import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  doublePrecision,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[|\]$/g, "").split(",").map(Number);
  },
});

export interface LinkLookupCandidate {
  url: string;
  title: string | null;
  similarity: number;
  gscClicks: number;
  gscImpressions: number;
  gscBoost: number;
  total: number;
  anchorHint: string | null;
  // True when this page is already linked in the relevant direction, so it is
  // an existing in-body link rather than a net-new suggestion.
  alreadyLinked?: boolean;
}

export interface LinkLookupExistingLink {
  url: string;
  title: string | null;
  anchorText: string | null;
}

export const linkLookupsTable = pgTable(
  "link_lookups",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .default(1)
      .references(() => sitesTable.id),
    kind: text("kind").notNull(),
    label: text("label"),
    inputValue: text("input_value").notNull(),
    resolvedUrl: text("resolved_url"),
    fetchedTitle: text("fetched_title"),
    fetchedH1: text("fetched_h1"),
    fetchedExcerpt: text("fetched_excerpt"),
    fetchedBodyText: text("fetched_body_text"),
    wordCount: integer("word_count").default(0),
    embedding: vector("embedding"),
    fetcherUsed: text("fetcher_used"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    outboundResults: jsonb("outbound_results").$type<LinkLookupCandidate[]>().default([]),
    inboundResults: jsonb("inbound_results").$type<LinkLookupCandidate[]>().default([]),
    existingOutbound: jsonb("existing_outbound").$type<LinkLookupExistingLink[]>().default([]),
    existingInbound: jsonb("existing_inbound").$type<LinkLookupExistingLink[]>().default([]),
    durationMs: doublePrecision("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    byCreated: index("link_lookups_created_idx").on(t.createdAt),
  }),
);

export type LinkLookup = typeof linkLookupsTable.$inferSelect;
