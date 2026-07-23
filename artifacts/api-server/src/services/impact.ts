import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { urlKey } from "./actionQueue";

/**
 * Impact tracking — measures what happened to a page's search performance
 * after work was completed on it. Pure SQL/arithmetic over gsc_snapshots;
 * nothing is materialized (weekly data, single admin).
 *
 * Method (per architect plan):
 * - Completion events come from three sources: manually/auto-completed
 *   action_items, optimize_queue rows marked done, and link_suggestions
 *   marked inserted. Events are grouped per normalized page path.
 * - GSC data is aggregated page-level: SUM clicks/impressions across all
 *   URL variants of a path (anchor-fragment URLs are separate rows in GSC —
 *   they must be summed, never overwritten), position = Σ(pos·impr)/Σimpr.
 * - Snapshot dates are deduped to the latest per ISO week (manual job
 *   re-runs create extra snapshot dates within a week).
 * - Baseline = average of up to 4 weeks strictly before the completion
 *   week; effect = rolling average of up to the 4 most recent weeks after
 *   it. A page is "measuring" until at least 2 post-completion weeks exist.
 *   Weeks where the site has data but the page has none count as zero.
 */

export interface ImpactMetrics {
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface ImpactWeekPoint {
  weekStart: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface ImpactEvent {
  source: "action" | "optimize" | "suggestion";
  kind: string;
  label: string | null;
  completedAt: string;
}

export type ImpactState = "measuring" | "improved" | "flat" | "declined";

export interface ImpactWinItem {
  path: string;
  url: string;
  events: ImpactEvent[];
  anchorCompletedAt: string;
  completionWeek: string;
  state: ImpactState;
  baseline: ImpactMetrics | null;
  after: ImpactMetrics | null;
  deltaClicks: number | null;
  deltaImpressions: number | null;
  deltaPosition: number | null;
  weeksBefore: number;
  weeksAfter: number;
}

interface EventRow {
  source: "action" | "optimize" | "suggestion";
  kind: string;
  url: string;
  label: string | null;
  completed_at: string;
}

interface WeekRow {
  week_start: string;
  path: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** SQL expression matching urlKey(): lowercase, strip scheme/www/query/fragment/trailing slash. */
const NORM_URL = sql.raw(
  `rtrim(split_part(split_part(regexp_replace(regexp_replace(lower(trim(url)), '^https?://', ''), '^www\\.', ''), '#', 1), '?', 1), '/')`,
);

/** Monday of the ISO week containing the given date (UTC). */
function isoWeekStart(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function avgMetrics(points: ImpactWeekPoint[]): ImpactMetrics | null {
  if (points.length === 0) return null;
  const clicks = points.reduce((a, p) => a + p.clicks, 0) / points.length;
  const impressions = points.reduce((a, p) => a + p.impressions, 0) / points.length;
  let posNum = 0;
  let posDen = 0;
  for (const p of points) {
    if (p.position != null && p.impressions > 0) {
      posNum += p.position * p.impressions;
      posDen += p.impressions;
    }
  }
  return {
    clicks: Math.round(clicks * 10) / 10,
    impressions: Math.round(impressions * 10) / 10,
    position: posDen > 0 ? Math.round((posNum / posDen) * 10) / 10 : null,
  };
}

function classify(
  baseline: ImpactMetrics | null,
  after: ImpactMetrics | null,
  weeksAfter: number,
): ImpactState {
  if (weeksAfter < 2 || !after || !baseline) return "measuring";
  // Primary metric: clicks when the page had meaningful clicks before,
  // otherwise impressions (low-click pages move on visibility first).
  const useClicks = baseline.clicks >= 5;
  const base = useClicks ? baseline.clicks : baseline.impressions;
  const eff = useClicks ? after.clicks : after.impressions;
  if (base <= 0) return eff > 0 ? "improved" : "flat";
  const rel = (eff - base) / base;
  if (rel >= 0.1) return "improved";
  if (rel <= -0.1) return "declined";
  return "flat";
}

/** All ISO weeks for which the site has any GSC data, deduped to latest snapshot per week. */
async function fetchWeekSnapshots(siteId: number): Promise<Array<{ weekStart: string; snapDate: string }>> {
  const result = (await db.execute(sql`
    SELECT date_trunc('week', snapshot_date::timestamp)::date::text AS week_start,
           max(snapshot_date)::text AS snap_date
    FROM gsc_snapshots
    WHERE site_id = ${siteId}
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as { rows: Array<{ week_start: string; snap_date: string }> };
  return (result.rows ?? []).map((r) => ({ weekStart: r.week_start, snapDate: r.snap_date }));
}

/** Weekly page-level series for a set of normalized paths. */
async function fetchWeeklySeries(siteId: number, paths: string[]): Promise<Map<string, Map<string, ImpactWeekPoint>>> {
  const byPath = new Map<string, Map<string, ImpactWeekPoint>>();
  if (paths.length === 0) return byPath;
  const result = (await db.execute(sql`
    WITH week_snap AS (
      SELECT date_trunc('week', snapshot_date::timestamp)::date AS week_start,
             max(snapshot_date) AS snap_date
      FROM gsc_snapshots
      WHERE site_id = ${siteId}
      GROUP BY 1
    )
    SELECT w.week_start::text AS week_start,
           ${NORM_URL} AS path,
           COALESCE(sum(g.clicks), 0)::int AS clicks,
           COALESCE(sum(g.impressions), 0)::int AS impressions,
           CASE WHEN COALESCE(sum(g.impressions), 0) > 0
                THEN sum(g.position * g.impressions) / sum(g.impressions)
                ELSE NULL END AS position
    FROM gsc_snapshots g
    JOIN week_snap w ON g.snapshot_date = w.snap_date
    WHERE g.site_id = ${siteId} AND ${NORM_URL} IN (${sql.join(
      paths.map((p) => sql`${p}`),
      sql`, `,
    )})
    GROUP BY 1, 2
    ORDER BY 1
  `)) as unknown as { rows: WeekRow[] };
  for (const r of result.rows ?? []) {
    let m = byPath.get(r.path);
    if (!m) {
      m = new Map();
      byPath.set(r.path, m);
    }
    m.set(r.week_start, {
      weekStart: r.week_start,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      position: r.position == null ? null : Number(r.position),
    });
  }
  return byPath;
}

async function fetchCompletionEvents(siteId: number): Promise<EventRow[]> {
  const result = (await db.execute(sql`
    SELECT 'action' AS source, action_type AS kind, target_url AS url,
           title AS label, completed_at::text AS completed_at
    FROM action_items
    WHERE status = 'done' AND completed_at IS NOT NULL AND site_id = ${siteId}
    UNION ALL
    SELECT 'optimize', 'optimize_content', url, NULL, completed_at::text
    FROM optimize_queue
    WHERE status = 'done' AND completed_at IS NOT NULL AND site_id = ${siteId}
    UNION ALL
    SELECT 'suggestion', 'link_inserted', receiver_url, anchor_text, reviewed_at::text
    FROM link_suggestions
    WHERE status = 'inserted' AND reviewed_at IS NOT NULL AND site_id = ${siteId}
  `)) as unknown as { rows: EventRow[] };
  return result.rows ?? [];
}

export async function computeImpactWins(siteId: number): Promise<{
  summary: Record<ImpactState, number>;
  items: ImpactWinItem[];
}> {
  const [events, weekSnaps] = await Promise.all([fetchCompletionEvents(siteId), fetchWeekSnapshots(siteId)]);
  const allWeeks = weekSnaps.map((w) => w.weekStart);

  // Group events per normalized path; anchor = most recent completion.
  const groups = new Map<string, { url: string; events: EventRow[] }>();
  for (const e of events) {
    const key = urlKey(e.url);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { url: e.url, events: [] };
      groups.set(key, g);
    }
    g.events.push(e);
  }

  const paths = [...groups.keys()];
  const seriesByPath = await fetchWeeklySeries(siteId, paths);

  const items: ImpactWinItem[] = [];
  for (const [path, g] of groups) {
    g.events.sort((a, b) => a.completed_at.localeCompare(b.completed_at));
    const anchor = g.events[g.events.length - 1]!.completed_at;
    const completionWeek = isoWeekStart(new Date(anchor));

    const series = seriesByPath.get(path) ?? new Map<string, ImpactWeekPoint>();
    const zeroFilled: ImpactWeekPoint[] = allWeeks.map(
      (w) => series.get(w) ?? { weekStart: w, clicks: 0, impressions: 0, position: null },
    );
    const before = zeroFilled.filter((p) => p.weekStart < completionWeek);
    const after = zeroFilled.filter((p) => p.weekStart > completionWeek);
    const baselineWin = before.slice(-4);
    const afterWin = after.slice(-4);

    const baseline = avgMetrics(baselineWin);
    const effect = avgMetrics(afterWin);
    const state = classify(baseline, effect, after.length);

    items.push({
      path,
      url: g.url,
      events: g.events.map((e) => ({
        source: e.source,
        kind: e.kind,
        label: e.label,
        completedAt: new Date(e.completed_at).toISOString(),
      })),
      anchorCompletedAt: new Date(anchor).toISOString(),
      completionWeek,
      state,
      baseline,
      after: effect,
      deltaClicks: baseline && effect ? Math.round((effect.clicks - baseline.clicks) * 10) / 10 : null,
      deltaImpressions:
        baseline && effect ? Math.round((effect.impressions - baseline.impressions) * 10) / 10 : null,
      deltaPosition:
        baseline?.position != null && effect?.position != null
          ? Math.round((effect.position - baseline.position) * 10) / 10
          : null,
      weeksBefore: baselineWin.length,
      weeksAfter: after.length,
    });
  }

  const stateOrder: Record<ImpactState, number> = { improved: 0, measuring: 1, flat: 2, declined: 3 };
  items.sort(
    (a, b) =>
      stateOrder[a.state] - stateOrder[b.state] ||
      (b.deltaClicks ?? 0) - (a.deltaClicks ?? 0) ||
      (b.deltaImpressions ?? 0) - (a.deltaImpressions ?? 0),
  );

  const summary: Record<ImpactState, number> = { measuring: 0, improved: 0, flat: 0, declined: 0 };
  for (const it of items) summary[it.state] += 1;

  return { summary, items };
}

export async function computeImpactDetail(siteId: number, rawUrl: string): Promise<{
  path: string;
  weeks: ImpactWeekPoint[];
}> {
  const path = urlKey(rawUrl);
  const [weekSnaps, seriesByPath] = await Promise.all([
    fetchWeekSnapshots(siteId),
    fetchWeeklySeries(siteId, [path]),
  ]);
  const series = seriesByPath.get(path) ?? new Map<string, ImpactWeekPoint>();
  const weeks = weekSnaps
    .map(
      (w) =>
        series.get(w.weekStart) ?? {
          weekStart: w.weekStart,
          clicks: 0,
          impressions: 0,
          position: null,
        },
    )
    .slice(-26);
  return { path, weeks };
}
