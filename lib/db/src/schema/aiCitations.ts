import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// Bing AI Performance report exports (Copilot / Bing AI citations). There is
// no API for this report as of mid-2026, so data arrives as manual file
// uploads from the Bing Webmaster Tools UI. Uploads are immutable snapshots;
// the NEWEST upload of each kind is the "active" one — re-uploading replaces
// the view (and the pages.ai_citations rollup) without any date-range merging.
export const aiCitationUploadsTable = pgTable("ai_citation_uploads", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  // "pages" = page-level citation counts; "grounding_queries" = the key
  // phrases the AI used when retrieving cited content.
  kind: text("kind").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  unmatchedCount: integer("unmatched_count").notNull().default(0),
  // Raw header row as detected in the file — kept for debugging format drift
  // (Microsoft changes this report's export columns without notice).
  rawHeaders: jsonb("raw_headers").$type<string[]>(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
});

export const aiCitationRowsTable = pgTable(
  "ai_citation_rows",
  {
    id: serial("id").primaryKey(),
    uploadId: integer("upload_id")
      .notNull()
      .references(() => aiCitationUploadsTable.id, { onDelete: "cascade" }),
    // Canonical path when the URL maps to this site (null for foreign /
    // blocklisted / unparseable URLs — kept for the unmatched report).
    path: text("path"),
    url: text("url"), // raw URL as it appeared in the export (pages kind)
    query: text("query"), // grounding query (grounding_queries kind)
    citations: integer("citations").notNull().default(0),
    // Any columns we didn't recognize land here instead of failing the upload.
    extra: jsonb("extra").$type<Record<string, string>>(),
  },
  (t) => ({
    byUpload: index("ai_citation_rows_upload_idx").on(t.uploadId),
    byPath: index("ai_citation_rows_path_idx").on(t.path),
  }),
);

export type AiCitationUpload = typeof aiCitationUploadsTable.$inferSelect;
export type AiCitationRow = typeof aiCitationRowsTable.$inferSelect;
