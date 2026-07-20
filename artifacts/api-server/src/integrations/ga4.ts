import { google } from "googleapis";
import { withCache } from "./gsc";
import { canonicalPath, isBlockedPath, loadBlockRegexes, siteHost } from "../lib/urlCanon";

const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA4_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function serviceAccount(): ServiceAccount {
  const raw = process.env["GA4_SERVICE_ACCOUNT_JSON"];
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON must be set");
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GA4_SERVICE_ACCOUNT_JSON missing client_email/private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export function ga4PropertyId(): string {
  const raw = process.env["GA4_PROPERTY_ID"];
  if (!raw) throw new Error("GA4_PROPERTY_ID must be set");
  return raw.replace(/^properties\//, "").trim();
}

async function accessToken(): Promise<string> {
  const sa = serviceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [GA4_SCOPE],
  });
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Failed to obtain GA4 access token");
  return token;
}

/** Which slice of traffic a GA4 view is scoped to. Default is organic. */
export type Ga4Channel = "organic" | "all";

// Key events the business cares about (verified against the property's
// metadata on 2026-07-20): signups + demo bookings. If an event is deleted
// in GA4 the runReport 400s, so keep this list in sync with the property.
const KEY_EVENT_METRICS = ["keyEvents:signup_success", "keyEvents:invitee_meeting_scheduled"];

const ORGANIC_CHANNEL_GROUP = "Organic Search";
// The property's default channel group already tags an "AI Assistant"
// channel, but some AI referrals still land under plain "Referral"
// (e.g. chatgpt.com) or "Unassigned" (e.g. bare "perplexity"), so we
// ALSO match by source string. Observed sources: chatgpt.com, claude.ai,
// gemini.google.com, perplexity(.ai), copilot.com.
const AI_CHANNEL_GROUP = "AI Assistant";
const AI_SOURCE_RE = /chatgpt|chat\.openai|perplexity|gemini\.google|copilot|claude/i;

export interface Ga4PageRow {
  path: string;
  engagementRate: number;
  sessions: number;
  engagedSessions: number;
  /** Average user engagement time per session, in seconds. */
  avgEngagementTime: number;
  /** Key events (signups + demo bookings) in sessions landing on this page. */
  keyEvents: number;
  /** Sessions referred by AI assistants (ChatGPT, Claude, Perplexity, Gemini, Copilot) — always counted across ALL channels. */
  aiSessions: number;
}

export interface Ga4Totals {
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTime: number;
  keyEvents: number;
  aiSessions: number;
}

interface RunReportResponse {
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  error?: { message?: string };
}

interface Bucket {
  sessions: number;
  engaged: number;
  dur: number;
  keyEvents: number;
}

interface RawPathAgg {
  path: string;
  all: Bucket;
  organic: Bucket;
  aiSessions: number;
}

const zeroBucket = (): Bucket => ({ sessions: 0, engaged: 0, dur: 0, keyEvents: 0 });

async function runReport(
  token: string,
  property: string,
  body: Record<string, unknown>,
): Promise<RunReportResponse> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as RunReportResponse;
  if (!res.ok) {
    throw new Error(json.error?.message ?? `GA4 runReport failed (${res.status})`);
  }
  return json;
}

/**
 * Two runReports per date range (cached 30 min): host-filtered engagement
 * (landing page × channel group × source) plus an unfiltered key-events
 * report, pre-reduced to per-path organic/all buckets so both channel views
 * and the AI column come from a single fetch.
 */
async function fetchRawPathAggs(startDate: string, endDate: string): Promise<RawPathAgg[]> {
  // v4: key events fetched WITHOUT the hostName filter (they fire on
  // app.wellows.com / calendly.com, never on the marketing host, so the
  // filtered report always reported 0).
  return withCache(`ga4:pages:v4|${startDate}|${endDate}`, GA4_CACHE_TTL_MS, async () => {
    const token = await accessToken();
    const property = ga4PropertyId();
    const block = await loadBlockRegexes();
    const dateRanges = [{ startDate, endDate }];

    // Report 1 — engagement, locked to the production site host: the GA4
    // property also receives hits from app screens / staging hosts whose
    // paths (e.g. /overview/*, /auth/*) would otherwise pollute page metrics.
    // Report 2 — key events, NO host filter: signup/demo events fire on the
    // app and Calendly hosts, so an event-level host filter drops all of
    // them even when the session LANDED on a marketing page. Landing page is
    // session-scoped, so rows still attribute conversions to marketing paths.
    const [engagement, keyEventsReport] = await Promise.all([
      runReport(token, property, {
        dateRanges,
        dimensions: [
          { name: "landingPage" },
          { name: "sessionDefaultChannelGroup" },
          { name: "sessionSource" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "engagedSessions" },
          { name: "userEngagementDuration" },
        ],
        dimensionFilter: {
          filter: {
            fieldName: "hostName",
            stringFilter: { matchType: "EXACT", value: siteHost() },
          },
        },
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "100000",
      }),
      runReport(token, property, {
        dateRanges,
        dimensions: [{ name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
        metrics: KEY_EVENT_METRICS.map((name) => ({ name })),
        limit: "100000",
      }),
    ]);

    // Aggregate by canonical path ("(not set)" landing pages fail
    // canonicalPath and drop out). Metrics for collapsing variants are
    // SUMMED, never overwritten.
    const agg = new Map<string, RawPathAgg>();
    for (const r of engagement.rows ?? []) {
      const d = r.dimensionValues ?? [];
      const path = canonicalPath(d[0]?.value ?? "");
      if (!path || isBlockedPath(path, block)) continue;
      const channelGroup = d[1]?.value ?? "";
      const source = d[2]?.value ?? "";
      const m = r.metricValues ?? [];
      const sessions = Number(m[0]?.value ?? 0);
      const engaged = Number(m[1]?.value ?? 0);
      const dur = Number(m[2]?.value ?? 0);

      let cur = agg.get(path);
      if (!cur) {
        cur = { path, all: zeroBucket(), organic: zeroBucket(), aiSessions: 0 };
        agg.set(path, cur);
      }
      cur.all.sessions += sessions;
      cur.all.engaged += engaged;
      cur.all.dur += dur;
      if (channelGroup === ORGANIC_CHANNEL_GROUP) {
        cur.organic.sessions += sessions;
        cur.organic.engaged += engaged;
        cur.organic.dur += dur;
      }
      // AI referrals are counted across ALL channels regardless of the
      // selected view — they mostly live under "AI Assistant"/"Referral",
      // never under "Organic Search".
      if (channelGroup === AI_CHANNEL_GROUP || AI_SOURCE_RE.test(source)) {
        cur.aiSessions += sessions;
      }
    }

    // Merge key events onto paths already present in the host-filtered
    // report. `landingPage` strips the hostname, so sessions landing
    // directly on app/staging hosts are only excluded because their paths
    // (/auth/*, /overview/*, /onboarding, /d/*) don't exist on the
    // marketing site — verified 2026-07-20. A same-path collision (e.g. an
    // app landing at bare "/") would merge onto the marketing page; in
    // practice the app redirects those to distinct paths, so the overlap is
    // negligible. GA4 has no session-scoped landing-hostname dimension to
    // close this fully.
    for (const r of keyEventsReport.rows ?? []) {
      const d = r.dimensionValues ?? [];
      const path = canonicalPath(d[0]?.value ?? "");
      if (!path) continue;
      const cur = agg.get(path);
      if (!cur) continue;
      const channelGroup = d[1]?.value ?? "";
      const m = r.metricValues ?? [];
      let keyEvents = 0;
      for (let i = 0; i < KEY_EVENT_METRICS.length; i++) {
        keyEvents += Number(m[i]?.value ?? 0);
      }
      cur.all.keyEvents += keyEvents;
      if (channelGroup === ORGANIC_CHANNEL_GROUP) {
        cur.organic.keyEvents += keyEvents;
      }
    }
    return Array.from(agg.values());
  });
}

export async function queryGa4Pages(opts: {
  startDate: string;
  endDate: string;
  channel: Ga4Channel;
}): Promise<{ rows: Ga4PageRow[]; totals: Ga4Totals }> {
  const raw = await fetchRawPathAggs(opts.startDate, opts.endDate);
  const rows: Ga4PageRow[] = [];
  const acc = { sessions: 0, engaged: 0, dur: 0, keyEvents: 0, aiSessions: 0 };
  for (const r of raw) {
    const b = opts.channel === "organic" ? r.organic : r.all;
    if (b.sessions === 0 && b.keyEvents === 0 && r.aiSessions === 0) continue;
    rows.push({
      path: r.path,
      sessions: b.sessions,
      engagedSessions: b.engaged,
      engagementRate: b.sessions > 0 ? b.engaged / b.sessions : 0,
      avgEngagementTime: b.sessions > 0 ? b.dur / b.sessions : 0,
      keyEvents: b.keyEvents,
      aiSessions: r.aiSessions,
    });
    acc.sessions += b.sessions;
    acc.engaged += b.engaged;
    acc.dur += b.dur;
    acc.keyEvents += b.keyEvents;
    acc.aiSessions += r.aiSessions;
  }
  rows.sort((x, y) => y.sessions - x.sessions);

  const totals: Ga4Totals = {
    sessions: acc.sessions,
    engagedSessions: acc.engaged,
    engagementRate: acc.sessions > 0 ? acc.engaged / acc.sessions : 0,
    avgEngagementTime: acc.sessions > 0 ? acc.dur / acc.sessions : 0,
    keyEvents: acc.keyEvents,
    aiSessions: acc.aiSessions,
  };
  return { rows, totals };
}
