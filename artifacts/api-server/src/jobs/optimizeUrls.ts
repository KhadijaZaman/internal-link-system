import {
  db,
  optimizeQueueTable,
  linkGraphTable,
  inventoryTable,
  pageTargetKeywordsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { queryGsc } from "../integrations/gsc";
import { fetchSerpTop5 } from "../integrations/dataforseo";
import { generateBrief } from "../integrations/openaiBrief";
import { assertPublicUrl, fetchPageInHouse } from "../integrations/htmlFetch";
import { type SiteContext } from "../lib/site";
import { budgetForSite } from "../lib/jobBudget";
import { logger } from "../lib/logger";

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type OptimizeItem = typeof optimizeQueueTable.$inferSelect;

export async function processOptimizeItem(
  item: OptimizeItem,
  site: SiteContext,
): Promise<void> {
  try {
    await db
      .update(optimizeQueueTable)
      .set({ status: "optimizing" })
      .where(and(eq(optimizeQueueTable.id, item.id), eq(optimizeQueueTable.siteId, site.id)));

    const rows = await queryGsc({
      siteId: item.siteId,
      startDate: dateOffset(90),
      endDate: dateOffset(1),
      dimensions: ["query"],
      pageFilter: item.url,
    });
    if (rows.length === 0) {
      await db
        .update(optimizeQueueTable)
        .set({ status: "skipped_no_gsc", completedAt: new Date() })
        .where(and(eq(optimizeQueueTable.id, item.id), eq(optimizeQueueTable.siteId, site.id)));
      return;
    }
    const buckets = {
      top3: rows.filter((r) => r.position <= 3),
      pos4_10: rows.filter((r) => r.position > 3 && r.position <= 10),
      pos11_20: rows.filter((r) => r.position > 10 && r.position <= 20),
      pos21plus: rows.filter((r) => r.position > 20),
    };
    let title = "";
    let h1 = "";
    let body = "";
    try {
      await assertPublicUrl(item.url);
      const pageContent = await fetchPageInHouse(item.url);
      title = pageContent.title;
      h1 = pageContent.h1 ?? "";
      body = pageContent.bodyText;
    } catch (fetchErr) {
      logger.warn({ err: fetchErr, url: item.url }, "Optimize: page fetch skipped");
    }
    const inv = await db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.siteId, site.id), eq(inventoryTable.url, item.url)))
      .limit(1);
    if (inv[0]) {
      if (!title && inv[0].title) title = inv[0].title;
      if (!h1 && inv[0].h1) h1 = inv[0].h1;
    }
    const inbound = await db
      .select()
      .from(linkGraphTable)
      .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.targetUrl, item.url)));
    const outbound = await db
      .select()
      .from(linkGraphTable)
      .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.sourceUrl, item.url)));
    const topQueries = [...rows].sort((a, b) => b.impressions - a.impressions).slice(0, 3);
    const competitors: Record<string, unknown> = {};
    for (const q of topQueries) {
      try {
        competitors[q.query] = await fetchSerpTop5(q.query);
      } catch (e) {
        logger.warn({ err: e, query: q.query }, "SERP fetch failed");
      }
    }
    const targetKeywordRows = await db
      .select({ keyword: pageTargetKeywordsTable.keyword })
      .from(pageTargetKeywordsTable)
      .where(
        and(
          eq(pageTargetKeywordsTable.siteId, site.id),
          eq(pageTargetKeywordsTable.url, item.url),
        ),
      );
    const targetKeywords = targetKeywordRows.map((r) => r.keyword);
    const { brief, groundingPassages } = await generateBrief({
      targetUrl: item.url,
      title,
      h1,
      notes: item.notes ?? "",
      bodyExcerpt: body,
      buckets,
      inbound: inbound.map((l) => ({ source: l.sourceUrl, anchor: l.anchorText })),
      outbound: outbound.map((l) => ({ target: l.targetUrl, anchor: l.anchorText })),
      competitors,
      targetKeywords,
    });
    await db
      .update(optimizeQueueTable)
      .set({ briefMarkdown: brief, groundingPassages, status: "done", completedAt: new Date() })
      .where(and(eq(optimizeQueueTable.id, item.id), eq(optimizeQueueTable.siteId, site.id)));
    logger.info({ id: item.id, url: item.url }, "Optimize: brief generated");
  } catch (e) {
    logger.error({ err: e, id: item.id }, "Optimize item failed");
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(optimizeQueueTable)
      .set({
        status: "failed",
        notes: `${item.notes ?? ""}\n[ERROR] ${errMsg}`.slice(0, 2000),
        completedAt: new Date(),
      })
      .where(and(eq(optimizeQueueTable.id, item.id), eq(optimizeQueueTable.siteId, site.id)));
  }
}

export async function runOptimizeQueuedUrls(site: SiteContext): Promise<void> {
  const budget = budgetForSite(site);
  const items = await db
    .select()
    .from(optimizeQueueTable)
    .where(
      and(eq(optimizeQueueTable.siteId, site.id), eq(optimizeQueueTable.status, "optimize")),
    );
  logger.info({ count: items.length }, "Optimize: items to process");
  let processed = 0;
  for (const item of items) {
    // Spend cap: each brief is a paid Anthropic (+ possible SERP/embedding)
    // operation. Stop the drain gracefully once the llmCalls budget is hit.
    if (!budget.take("llmCalls")) {
      const remaining = items.length - processed;
      logger.warn(
        { remaining, budget: budget.summary() },
        "Optimize: llm budget exhausted; stopping (items left in queue)",
      );
      break;
    }
    await processOptimizeItem(item, site);
    processed++;
  }
  if (budget.anyExhausted()) {
    logger.warn({ budget: budget.summary() }, "Optimize: spend cap hit this run");
  }
}
