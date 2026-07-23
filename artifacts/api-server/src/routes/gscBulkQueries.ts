import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireLegacySiteOwner } from "../lib/site";
import { queryGscDimension } from "../integrations/gsc";

const router: IRouter = Router();

const MAX_URLS = 50;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 28;
const MAX_QUERIES_PER_URL = 50;
const CONCURRENCY = 4;

type Tier = "defend" | "striking_distance" | "off_page_one" | "stretch";

interface RankedQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  tier: Tier;
  priority: number;
  estIncrementalClicks: number;
  reason: string;
}

interface UrlResult {
  url: string;
  ok: boolean;
  error?: string;
  totals?: { clicks: number; impressions: number; ctr: number; position: number };
  queries: RankedQuery[];
}

// Rough industry-average CTR curve by position (decimal). Used to estimate
// "incremental clicks if you moved into the target band". These are blended
// numbers — fine for ranking, not for forecasting.
const CTR_AT_POS: Record<number, number> = {
  1: 0.30,
  2: 0.15,
  3: 0.10,
  4: 0.07,
  5: 0.05,
  6: 0.04,
  7: 0.03,
  8: 0.025,
  9: 0.022,
  10: 0.02,
};

function targetCtrForBucket(position: number): number {
  if (position <= 3) return CTR_AT_POS[Math.max(1, Math.round(position))]!;
  if (position <= 10) return CTR_AT_POS[3]!; // striking distance → push to pos 3
  if (position <= 20) return CTR_AT_POS[5]!; // off page one → push to pos 5
  return CTR_AT_POS[10]!; // stretch → push into top 10
}

function classify(position: number): Tier {
  if (position <= 3) return "defend";
  if (position <= 10) return "striking_distance";
  if (position <= 20) return "off_page_one";
  return "stretch";
}

function reasonFor(t: Tier, position: number): string {
  switch (t) {
    case "defend":
      return `Already ranking at pos ${position.toFixed(1)} — protect with freshness + internal links.`;
    case "striking_distance":
      return `Pos ${position.toFixed(1)} — small content/anchor push moves it into top 3.`;
    case "off_page_one":
      return `Pos ${position.toFixed(1)} (page 2) — biggest unlock per impression. Prioritize.`;
    case "stretch":
      return `Pos ${position.toFixed(1)} — needs structural rewrite or new section to break in.`;
  }
}

function score(row: { clicks: number; impressions: number; ctr: number; position: number }): {
  priority: number;
  estIncrementalClicks: number;
} {
  const targetCtr = targetCtrForBucket(row.position);
  const incremental = Math.max(0, row.impressions * (targetCtr - row.ctr));
  // Bias multipliers per tier so the highest-leverage band floats to the top
  // when impressions are roughly comparable.
  const tier = classify(row.position);
  const bias =
    tier === "off_page_one" ? 1.5 :
    tier === "striking_distance" ? 1.2 :
    tier === "defend" ? 0.7 :
    0.5;
  return {
    priority: Math.round(incremental * bias * 10) / 10,
    estIncrementalClicks: Math.round(incremental * 10) / 10,
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchForUrl(url: string, startDate: string, endDate: string): Promise<UrlResult> {
  try {
    const rows = await queryGscDimension({
      startDate,
      endDate,
      dimension: "query",
      pageFilter: url,
      rowLimit: 5000,
    });
    let totalClicks = 0, totalImpr = 0, posSum = 0, posWeight = 0;
    for (const r of rows) {
      totalClicks += r.clicks;
      totalImpr += r.impressions;
      posSum += r.position * Math.max(r.impressions, 1);
      posWeight += Math.max(r.impressions, 1);
    }
    const ranked: RankedQuery[] = rows
      .filter((r) => r.impressions > 0 && r.key.length > 0)
      .map((r) => {
        const tier = classify(r.position);
        const { priority, estIncrementalClicks } = score(r);
        return {
          query: r.key,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: Number(r.ctr.toFixed(4)),
          position: Number(r.position.toFixed(2)),
          tier,
          priority,
          estIncrementalClicks,
          reason: reasonFor(tier, r.position),
        };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_QUERIES_PER_URL);
    return {
      url,
      ok: true,
      totals: {
        clicks: totalClicks,
        impressions: totalImpr,
        ctr: totalImpr > 0 ? Number((totalClicks / totalImpr).toFixed(4)) : 0,
        position: posWeight > 0 ? Number((posSum / posWeight).toFixed(2)) : 0,
      },
      queries: ranked,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      queries: [],
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

router.post("/gsc/bulk-queries", requireAuth, requireLegacySiteOwner, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawUrls = Array.isArray(body["urls"]) ? body["urls"] : [];
  const days = Math.min(
    MAX_DAYS,
    Math.max(1, Number.isFinite(body["days"]) ? Number(body["days"]) : DEFAULT_DAYS),
  );

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const u of rawUrls) {
    if (typeof u !== "string") continue;
    const trimmed = u.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
    if (trimmed.length > 2048) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
    if (urls.length >= MAX_URLS) break;
  }

  if (urls.length === 0) {
    res.status(400).json({ error: "urls[] must contain at least one valid http(s) URL" });
    return;
  }

  const endDate = isoDaysAgo(2); // GSC has ~2-day data lag
  const startDate = isoDaysAgo(2 + days - 1);

  try {
    const results = await runWithConcurrency(urls, CONCURRENCY, (u) =>
      fetchForUrl(u, startDate, endDate),
    );
    res.json({
      range: { startDate, endDate, days },
      results,
    });
  } catch (err) {
    req.log.error({ err }, "GSC bulk-queries failed");
    res.status(502).json({ error: "GSC request failed" });
  }
});

export default router;
