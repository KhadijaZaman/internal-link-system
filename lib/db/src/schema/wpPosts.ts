import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
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

export const wpPostsTable = pgTable(
  "wp_posts",
  {
    url: text("url").primaryKey(),
    type: text("type").notNull(), // "post" | "page"
    title: text("title"),
    slug: text("slug"),
    publishDate: timestamp("publish_date", { withTimezone: true }),
    modifiedDate: timestamp("modified_date", { withTimezone: true }),
    excerpt: text("excerpt"),
    bodyText: text("body_text"),
    h1: text("h1"),
    h2List: jsonb("h2_list").$type<string[]>().default([]),
    focusKeyword: text("focus_keyword"),
    wordCount: integer("word_count").default(0),
    // Outbound internal links discovered on this post, tagged by placement
    // (content vs nav/header/footer). Refreshed on every crawl, so legacy
    // `string[]` rows are overwritten with the tagged shape on next run.
    outboundInternalLinks: jsonb("outbound_internal_links")
      .$type<Array<{ url: string; placement: "content" | "nav" | "header" | "footer" }>>()
      .default([]),
    embedding: vector("embedding"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    crawledAt: timestamp("crawled_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    typeIdx: index("wp_posts_type_idx").on(t.type),
  }),
);

export type WpPost = typeof wpPostsTable.$inferSelect;
