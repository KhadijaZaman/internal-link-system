import { google } from "googleapis";
import { withCache } from "./gsc";

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

export interface Ga4PageRow {
  path: string;
  engagementRate: number;
  sessions: number;
  engagedSessions: number;
  screenPageViews: number;
  /** Average user engagement time per session, in seconds. */
  avgEngagementTime: number;
}

export interface Ga4Totals {
  sessions: number;
  engagedSessions: number;
  screenPageViews: number;
  engagementRate: number;
  avgEngagementTime: number;
}

interface RunReportResponse {
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  error?: { message?: string };
}

function normalizePath(p: string): string {
  const noQuery = p.split("?")[0] ?? p;
  const noHash = noQuery.split("#")[0] ?? noQuery;
  let s = noHash.toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
}

export async function queryGa4Pages(opts: {
  startDate: string;
  endDate: string;
}): Promise<{ rows: Ga4PageRow[]; totals: Ga4Totals }> {
  const { startDate, endDate } = opts;
  return withCache(`ga4:pages|${startDate}|${endDate}`, GA4_CACHE_TTL_MS, async () => {
    const token = await accessToken();
    const property = ga4PropertyId();
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "pagePath" }],
          metrics: [
            { name: "sessions" },
            { name: "engagedSessions" },
            { name: "screenPageViews" },
            { name: "userEngagementDuration" },
          ],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: "100000",
        }),
      },
    );
    const json = (await res.json()) as RunReportResponse;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `GA4 runReport failed (${res.status})`);
    }

    // Aggregate by normalized path so trailing-slash / query variants collapse
    // into one row, then derive rates from summed sessions for consistency.
    const agg = new Map<string, { sessions: number; engaged: number; views: number; dur: number }>();
    for (const r of json.rows ?? []) {
      const path = normalizePath(r.dimensionValues?.[0]?.value ?? "");
      const m = r.metricValues ?? [];
      const cur = agg.get(path) ?? { sessions: 0, engaged: 0, views: 0, dur: 0 };
      cur.sessions += Number(m[0]?.value ?? 0);
      cur.engaged += Number(m[1]?.value ?? 0);
      cur.views += Number(m[2]?.value ?? 0);
      cur.dur += Number(m[3]?.value ?? 0);
      agg.set(path, cur);
    }

    const rows: Ga4PageRow[] = [];
    const acc = { sessions: 0, engaged: 0, views: 0, dur: 0 };
    for (const [path, a] of agg) {
      if (a.sessions === 0 && a.views === 0) continue;
      rows.push({
        path,
        sessions: a.sessions,
        engagedSessions: a.engaged,
        screenPageViews: a.views,
        engagementRate: a.sessions > 0 ? a.engaged / a.sessions : 0,
        avgEngagementTime: a.sessions > 0 ? a.dur / a.sessions : 0,
      });
      acc.sessions += a.sessions;
      acc.engaged += a.engaged;
      acc.views += a.views;
      acc.dur += a.dur;
    }
    rows.sort((x, y) => y.sessions - x.sessions);

    const totals: Ga4Totals = {
      sessions: acc.sessions,
      engagedSessions: acc.engaged,
      screenPageViews: acc.views,
      engagementRate: acc.sessions > 0 ? acc.engaged / acc.sessions : 0,
      avgEngagementTime: acc.sessions > 0 ? acc.dur / acc.sessions : 0,
    };
    return { rows, totals };
  });
}
