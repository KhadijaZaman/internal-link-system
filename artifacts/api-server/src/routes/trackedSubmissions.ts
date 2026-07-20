import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, trackedSubmissionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  CreateTrackedSubmissionsBody,
  UpdateTrackedSubmissionBody,
} from "@workspace/api-zod";
import {
  queryGscDimension,
  aggregateTotals,
  withCache,
  GSC_CACHE_TTL_MS,
  pageVariantsRegex,
  keywordExactRegex,
  type GscDimensionRow,
} from "../integrations/gsc";

const router: IRouter = Router();

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function serialize(t: typeof trackedSubmissionsTable.$inferSelect) {
  return {
    id: t.id,
    url: t.url,
    keyword: t.keyword,
    label: t.label,
    note: t.note,
    status: t.status,
    createdAt: (t.createdAt ?? new Date()).toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

router.get("/tracked-submissions", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(trackedSubmissionsTable)
    .orderBy(desc(trackedSubmissionsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/tracked-submissions", requireAuth, async (req, res) => {
  const parsed = CreateTrackedSubmissionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const note = parsed.data.note?.trim() || null;
  // Legacy shared keyword doubles as the default for items without their own.
  const defaultKeyword = parsed.data.keyword?.trim() || null;

  const rawItems: { url: string; keyword: string | null }[] = [
    ...(parsed.data.items ?? []).map((it) => ({
      url: it.url.trim(),
      keyword: it.keyword?.trim() || defaultKeyword,
    })),
    ...(parsed.data.urls ?? []).map((u) => ({
      url: u.trim(),
      keyword: defaultKeyword,
    })),
  ];

  const seen = new Set<string>();
  const items = rawItems
    .filter((it) => it.url.length > 0 && isHttpUrl(it.url))
    .filter((it) => {
      const key = it.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (items.length === 0) {
    res.status(400).json({ error: "No valid http(s) URLs" });
    return;
  }

  // Upsert by URL: re-pasting a list updates keywords instead of duplicating.
  // Case-insensitive match so re-pasting with different casing can't duplicate.
  const existing = await db
    .select()
    .from(trackedSubmissionsTable)
    .where(
      inArray(
        sql`lower(${trackedSubmissionsTable.url})`,
        items.map((it) => it.url.toLowerCase()),
      ),
    );
  const byUrl = new Map(existing.map((row) => [row.url.toLowerCase(), row]));

  const toInsert: { url: string; note: string | null; keyword: string | null }[] = [];
  const results: (typeof trackedSubmissionsTable.$inferSelect)[] = [];
  for (const it of items) {
    const ex = byUrl.get(it.url.toLowerCase());
    if (!ex) {
      toInsert.push({ url: it.url, note, keyword: it.keyword });
      continue;
    }
    if (it.keyword && it.keyword !== ex.keyword) {
      const updated = await db
        .update(trackedSubmissionsTable)
        .set({ keyword: it.keyword })
        .where(eq(trackedSubmissionsTable.id, ex.id))
        .returning();
      if (updated[0]) results.push(updated[0]);
    } else {
      results.push(ex);
    }
  }
  if (toInsert.length > 0) {
    const inserted = await db
      .insert(trackedSubmissionsTable)
      .values(toInsert)
      .returning();
    results.push(...inserted);
  }
  res.status(201).json(results.map(serialize));
});

router.patch("/tracked-submissions/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateTrackedSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const patch: Partial<typeof trackedSubmissionsTable.$inferInsert> = {};
  if (parsed.data.status !== undefined) {
    patch.status = parsed.data.status;
    patch.completedAt = parsed.data.status === "done" ? new Date() : null;
  }
  if (parsed.data.keyword !== undefined) {
    patch.keyword = parsed.data.keyword?.trim() || null;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const updated = await db
    .update(trackedSubmissionsTable)
    .set(patch)
    .where(eq(trackedSubmissionsTable.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

router.delete("/tracked-submissions/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(trackedSubmissionsTable)
    .where(eq(trackedSubmissionsTable.id, id));
  res.json({ ok: true });
});

// ---------- Keyword / URL performance (GSC only — no crawl, no AI) ----------

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toSeriesPoint(r: GscDimensionRow) {
  return {
    date: r.key,
    clicks: Math.round(r.clicks),
    impressions: Math.round(r.impressions),
    ctr: r.ctr,
    position: r.position,
  };
}

router.get(
  "/tracked-submissions/:id/performance",
  requireAuth,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const daysRaw = Number(req.query["days"] ?? 28);
    const days = Math.min(180, Math.max(7, Number.isFinite(daysRaw) ? Math.round(daysRaw) : 28));
    const countryRaw = typeof req.query["country"] === "string" ? req.query["country"].trim() : "";
    // "all" is rejected: it's the worldwide cache-key sentinel, not an ISO code.
    if (countryRaw && (!/^[A-Za-z]{3}$/.test(countryRaw) || countryRaw.toLowerCase() === "all")) {
      res.status(400).json({ error: "country must be a 3-letter ISO code" });
      return;
    }
    const country = countryRaw ? countryRaw.toLowerCase() : null;

    const rows = await db
      .select()
      .from(trackedSubmissionsTable)
      .where(eq(trackedSubmissionsTable.id, id));
    const sub = rows[0];
    if (!sub) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // GSC data lags ~2 days behind real time.
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 2);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);

    const endDate = isoDay(end);
    const startDate = isoDay(start);
    const prevStartDate = isoDay(prevStart);
    const pageRegex = pageVariantsRegex(sub.url);
    const keyword = sub.keyword?.trim() || null;

    const cacheKey = `tracked-perf:${id}:${sub.url}:${keyword ?? ""}:${days}:${country ?? "all"}:${endDate}`;
    try {
      const payload = await withCache(cacheKey, GSC_CACHE_TTL_MS, async () => {
        // One call per scope covering current + previous window, split locally.
        const countryFilter = country ?? undefined;
        const [overallDaily, keywordDaily, queryRows] = await Promise.all([
          queryGscDimension({
            startDate: prevStartDate,
            endDate,
            dimension: "date",
            pageRegex,
            countryFilter,
          }),
          keyword
            ? queryGscDimension({
                startDate: prevStartDate,
                endDate,
                dimension: "date",
                pageRegex,
                queryFilter: {
                  expression: keywordExactRegex(keyword),
                  operator: "includingRegex",
                },
                countryFilter,
              })
            : Promise.resolve([] as GscDimensionRow[]),
          queryGscDimension({
            startDate,
            endDate,
            dimension: "query",
            pageRegex,
            rowLimit: 25,
            countryFilter,
          }),
        ]);

        const splitWindow = (daily: GscDimensionRow[]) => {
          const current = daily.filter((r) => r.key >= startDate);
          const previous = daily.filter((r) => r.key < startDate);
          return { current, previous };
        };

        const overall = splitWindow(overallDaily);
        const kw = splitWindow(keywordDaily);

        const topQueries = queryRows
          .slice()
          .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
          .slice(0, 10)
          .map((r) => ({
            query: r.key,
            clicks: Math.round(r.clicks),
            impressions: Math.round(r.impressions),
            ctr: r.ctr,
            position: r.position,
            isTracked:
              keyword != null &&
              r.key.toLowerCase().replace(/\s+/g, " ").trim() ===
                keyword.toLowerCase().replace(/\s+/g, " ").trim(),
          }));

        return {
          id: sub.id,
          url: sub.url,
          keyword,
          startDate,
          endDate,
          overallSeries: overall.current.map(toSeriesPoint),
          overallTotals: aggregateTotals(overall.current),
          overallPrevTotals:
            overall.previous.length > 0 ? aggregateTotals(overall.previous) : null,
          keywordSeries: kw.current.map(toSeriesPoint),
          keywordTotals: keyword && kw.current.length > 0 ? aggregateTotals(kw.current) : null,
          keywordPrevTotals:
            keyword && kw.previous.length > 0 ? aggregateTotals(kw.previous) : null,
          topQueries,
        };
      });
      res.json(payload);
    } catch (err) {
      req.log.error({ err, id }, "tracked submission performance fetch failed");
      res.status(502).json({ error: "Search Console request failed" });
    }
  },
);

export default router;
