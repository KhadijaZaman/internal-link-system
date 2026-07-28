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

/** One AI-generated link-map proposal (from → to with anchor + justification). */
export interface LinkMapProposal {
  from: string;
  to: string;
  anchorText: string;
  placement: string;
  bridgeSentence: string;
  rules: string[];
  why: string;
}

export interface LinkMapFlag {
  /** orphan | hub_hoards | anchor_collision | reciprocal_pair | depth | link_dump | other */
  type: string;
  page: string;
  detail: string;
}

export interface LinkMapDoNotLink {
  from: string;
  to: string;
  reason: string;
}

export interface LinkMapResult {
  proposals: LinkMapProposal[];
  flags: LinkMapFlag[];
  doNotLink: LinkMapDoNotLink[];
}

/**
 * In-app AI link-map generation runs. The INPUTS block is built from real
 * site data (inventory H1s/queries, link-stats inbound counts, link-graph
 * content edges) and the R1–R10 rules prompt is executed against Claude —
 * strictly user-initiated (never on page load).
 */
export const linkMapRunsTable = pgTable(
  "link_map_runs",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id),
    status: text("status").notNull().default("running"), // running | complete | error
    error: text("error"),
    centralEntity: text("central_entity").notNull(),
    hubUrl: text("hub_url"),
    maxNewLinksPerPage: integer("max_new_links_per_page").notNull().default(4),
    /** The exact page URLs sent to the model. */
    pageUrls: jsonb("page_urls").$type<string[]>().notNull(),
    model: text("model").notNull(),
    result: jsonb("result").$type<LinkMapResult | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("link_map_runs_site_idx").on(t.siteId, t.startedAt)],
);

export type LinkMapRunRow = typeof linkMapRunsTable.$inferSelect;
