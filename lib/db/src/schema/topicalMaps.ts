import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Topical Authority Map runs. Each generate creates a NEW row (history kept);
 * run state lives on the row itself, mirroring cluster_runs/similarity_runs.
 */
export const topicalMapsTable = pgTable("topical_maps", {
  id: serial("id").primaryKey(),
  /** queued | running | complete | failed | interrupted */
  status: text("status").notNull().default("queued"),
  phase: text("phase"),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  error: text("error"),
  /** One-paragraph source context charter (who we are + monetization bridge). */
  sourceContext: text("source_context").notNull(),
  centralEntity: text("central_entity").notNull(),
  entitySynonyms: jsonb("entity_synonyms").$type<string[]>().notNull().default([]),
  /** One-sentence central search intent with predicates. */
  centralSearchIntent: text("central_search_intent").notNull(),
  bordersWill: jsonb("borders_will").$type<string[]>().notNull().default([]),
  bordersWillNot: jsonb("borders_will_not").$type<string[]>().notNull().default([]),
  /** Rollup counts (nodes, published, gaps, pillars, bridges, matched…). */
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
});

export const topicalMapNodesTable = pgTable(
  "topical_map_nodes",
  {
    id: serial("id").primaryKey(),
    mapId: integer("map_id")
      .notNull()
      .references(() => topicalMapsTable.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references(
      (): AnyPgColumn => topicalMapNodesTable.id,
      { onDelete: "cascade" },
    ),
    /** pillar | core_topic | supporting | subtopic */
    level: text("level").notNull(),
    /** core | outer */
    section: text("section").notNull(),
    title: text("title").notNull(),
    /** The ONE query this node owns. */
    canonicalQuery: text("canonical_query").notNull(),
    /** The ONE entity-attribute pair this node owns (macro context). */
    attributeOwned: text("attribute_owned").notNull(),
    /** informational | commercial | transactional | navigational */
    intent: text("intent").notNull(),
    /** know | learn | compare | use | buy | fix | go (comma-joined when several) */
    predicate: text("predicate").notNull(),
    /** tofu | mofu | bofu | retention */
    funnelStage: text("funnel_stage").notNull(),
    /** guide | how_to | comparison | listicle | definition | landing | tool … */
    pageType: text("page_type").notNull(),
    suggestedSlug: text("suggested_slug").notNull(),
    suggestedTitle: text("suggested_title").notNull(),
    /** What this page must add that the SERP lacks. */
    informationGain: text("information_gain"),
    /** One-line border rule: covers X, defers Y to sibling. */
    borderNote: text("border_note"),
    /** high | medium | low */
    priority: text("priority").notNull().default("medium"),
    /** published (matched to a live page) | gap (planned) | ignored (operator dismissed) */
    status: text("status").notNull().default("gap"),
    /** Canonical path of the matched existing page, when published. */
    matchedPagePath: text("matched_page_path"),
    /** exact_slug | top_query | embedding — how the match was made. */
    matchSource: text("match_source"),
    /** Cosine similarity for embedding matches (0–1). */
    matchConfidence: real("match_confidence"),
    /** Stable sibling ordering for rendering. */
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("topical_map_nodes_map_idx").on(t.mapId),
    index("topical_map_nodes_parent_idx").on(t.parentId),
  ],
);

export const topicalMapBridgesTable = pgTable(
  "topical_map_bridges",
  {
    id: serial("id").primaryKey(),
    mapId: integer("map_id")
      .notNull()
      .references(() => topicalMapsTable.id, { onDelete: "cascade" }),
    sourceNodeId: integer("source_node_id")
      .notNull()
      .references(() => topicalMapNodesTable.id, { onDelete: "cascade" }),
    targetNodeId: integer("target_node_id")
      .notNull()
      .references(() => topicalMapNodesTable.id, { onDelete: "cascade" }),
    /** The shared sub-concept justifying the cross-link. */
    bridgeConcept: text("bridge_concept").notNull(),
  },
  (t) => [index("topical_map_bridges_map_idx").on(t.mapId)],
);

export type TopicalMap = typeof topicalMapsTable.$inferSelect;
export type TopicalMapNode = typeof topicalMapNodesTable.$inferSelect;
export type TopicalMapBridge = typeof topicalMapBridgesTable.$inferSelect;
