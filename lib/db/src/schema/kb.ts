import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  customType,
  index,
} from "drizzle-orm/pg-core";

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

/**
 * Operator-uploaded knowledge base used to ground optimization briefs. The
 * operator pastes long-form source material (e.g. Koray Tugberk Gubur semantic
 * SEO transcripts); each document is split into overlapping chunks at upload
 * time and each chunk is embedded with text-embedding-3-small (1536d). At brief
 * generation we embed the page's primary query/title/h1 and pull the top-k
 * chunks by cosine similarity to inject as grounding context.
 *
 * Manually maintained (user-entered) — not populated by any job.
 */
export const kbDocumentsTable = pgTable("kb_documents", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  charCount: integer("char_count").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const kbChunksTable = pgTable(
  "kb_chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding"),
  },
  (t) => ({
    documentIdIdx: index("kb_chunks_document_id_idx").on(t.documentId),
  }),
);

export type KbDocument = typeof kbDocumentsTable.$inferSelect;
export type KbChunk = typeof kbChunksTable.$inferSelect;
