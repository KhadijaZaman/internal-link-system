/**
 * Pure mapping of raw GA4 daily rows onto a per-day series for one landing
 * page. The network fetch lives in integrations/ga4.ts; everything here is
 * db-free and unit-tested.
 *
 * GA4 gotchas encoded here:
 * - Key-event metrics fire on the app/Calendly hosts, NOT the marketing host,
 *   so key-event rows arrive from an UNFILTERED runReport and are joined by
 *   canonical landing-page path.
 * - landingPage values can carry query strings and variants; rows are matched
 *   by canonical path, never raw string equality.
 * - AI sessions are counted across ALL channels (channel group "AI Assistant"
 *   or a known AI referrer source).
 */
import { canonicalPath } from "./urlCanon";

export const ORGANIC_CHANNEL_GROUP = "Organic Search";
export const AI_CHANNEL_GROUP = "AI Assistant";
export const AI_SOURCE_RE = /chatgpt|chat\.openai|perplexity|gemini\.google|copilot|claude/i;

export interface Ga4DailyEngagementRow {
  date: string; // GA4 "YYYYMMDD"
  landingPage: string;
  channelGroup: string;
  source: string;
  sessions: number;
  engagedSessions: number;
  engagementDuration: number; // seconds
}

export interface Ga4DailyKeyEventRow {
  date: string; // GA4 "YYYYMMDD"
  landingPage: string;
  keyEvents: number;
}

export interface Ga4DayAgg {
  date: string; // ISO "YYYY-MM-DD"
  sessions: number;
  engagedSessions: number;
  engagementDuration: number;
  keyEvents: number;
  aiSessions: number;
}

export interface Ga4TotalsOut {
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTime: number;
  keyEvents: number;
  aiSessions: number;
}

/** GA4 date dimension "20260722" → "2026-07-22"; null for malformed input. */
export function ga4DateToIso(d: string): string | null {
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function isAiRow(channelGroup: string, source: string): boolean {
  return channelGroup === AI_CHANNEL_GROUP || AI_SOURCE_RE.test(source);
}

/**
 * Collapse raw GA4 rows (already decoded from the Data API response) onto a
 * per-day series for the given canonical path. Rows for other pages (the
 * BEGINS_WITH fetch filter can over-match, e.g. /guide matching /guide-2)
 * are dropped here via canonical-path equality.
 */
export function buildGa4DailySeries(opts: {
  engagementRows: Ga4DailyEngagementRow[];
  keyEventRows: Ga4DailyKeyEventRow[];
  path: string;
  siteHost: string;
}): Ga4DayAgg[] {
  const { engagementRows, keyEventRows, path, siteHost } = opts;
  const byDate = new Map<string, Ga4DayAgg>();

  const dayFor = (iso: string): Ga4DayAgg => {
    let agg = byDate.get(iso);
    if (!agg) {
      agg = {
        date: iso,
        sessions: 0,
        engagedSessions: 0,
        engagementDuration: 0,
        keyEvents: 0,
        aiSessions: 0,
      };
      byDate.set(iso, agg);
    }
    return agg;
  };

  for (const row of engagementRows) {
    const iso = ga4DateToIso(row.date);
    if (!iso) continue;
    if (canonicalPath(row.landingPage, siteHost) !== path) continue;
    const agg = dayFor(iso);
    agg.sessions += row.sessions;
    agg.engagedSessions += row.engagedSessions;
    agg.engagementDuration += row.engagementDuration;
    if (isAiRow(row.channelGroup, row.source)) agg.aiSessions += row.sessions;
  }

  for (const row of keyEventRows) {
    const iso = ga4DateToIso(row.date);
    if (!iso) continue;
    if (canonicalPath(row.landingPage, siteHost) !== path) continue;
    dayFor(iso).keyEvents += row.keyEvents;
  }

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Convert one day's aggregate to the API shape (rates derived, not stored). */
export function ga4DayPoint(agg: Ga4DayAgg): {
  date: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTime: number;
  keyEvents: number;
  aiSessions: number;
} {
  return {
    date: agg.date,
    sessions: agg.sessions,
    engagedSessions: agg.engagedSessions,
    engagementRate: agg.sessions > 0 ? agg.engagedSessions / agg.sessions : 0,
    avgEngagementTime: agg.sessions > 0 ? agg.engagementDuration / agg.sessions : 0,
    keyEvents: agg.keyEvents,
    aiSessions: agg.aiSessions,
  };
}

export function aggregateGa4Days(days: Ga4DayAgg[]): Ga4TotalsOut {
  const sessions = days.reduce((s, d) => s + d.sessions, 0);
  const engaged = days.reduce((s, d) => s + d.engagedSessions, 0);
  const duration = days.reduce((s, d) => s + d.engagementDuration, 0);
  return {
    sessions,
    engagedSessions: engaged,
    engagementRate: sessions > 0 ? engaged / sessions : 0,
    avgEngagementTime: sessions > 0 ? duration / sessions : 0,
    keyEvents: days.reduce((s, d) => s + d.keyEvents, 0),
    aiSessions: days.reduce((s, d) => s + d.aiSessions, 0),
  };
}
