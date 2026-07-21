import { siteOrigin } from "../lib/urlCanon";

// Bing Webmaster API (classic). Covers regular Bing organic search stats.
// NOTE: the AI Performance report (Copilot / Bing AI citations) has NO API
// as of July 2026 — that data arrives via manual export uploads instead
// (see routes/bing.ts). When Microsoft ships the promised API, add the
// fetcher here and swap the upload path for a sync job.
//
// Quirks (verified against the live API on 2026-07-21):
// - GetPageStats returns rows whose URL lives in a field literally named
//   "Query" (same DTO as GetQueryStats).
// - Dates arrive as "/Date(1746774000000-0700)/" — ms epoch + display
//   offset. Buckets are weekly-ish; the window is a rolling ~6 months and
//   there are NO date-range parameters.
// - AvgImpressionPosition / AvgClickPosition are -1 when unknown.

const BING_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

function apiKey(): string {
  const k = process.env["BING_WEBMASTER_API_KEY"];
  if (!k) throw new Error("BING_WEBMASTER_API_KEY must be set");
  return k;
}

/** Bing property URL. The verified property is the bare https origin. */
export function bingSiteUrl(): string {
  return siteOrigin();
}

interface RawStatRow {
  Query?: string;
  Clicks?: number;
  Impressions?: number;
  AvgImpressionPosition?: number;
  AvgClickPosition?: number;
  Date?: string;
}

export interface BingStatRow {
  /** Raw value of the "Query" field: a query string OR a page URL. */
  key: string;
  bucketDate: string; // YYYY-MM-DD as Bing reported it (offset applied)
  clicks: number;
  impressions: number;
  position: number | null; // AvgImpressionPosition, null when Bing sends -1
}

/** Parse "/Date(1746774000000-0700)/" into the YYYY-MM-DD Bing intended. */
export function parseBingDate(raw: string): string | null {
  const m = /\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\//.exec(raw);
  if (!m || !m[1]) return null;
  let ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  if (m[2] && m[3] && m[4]) {
    const offsetMs = (Number(m[3]) * 60 + Number(m[4])) * 60_000;
    ms += m[2] === "-" ? -offsetMs : offsetMs;
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function callBing(method: string): Promise<RawStatRow[]> {
  const url = `${BING_BASE}/${method}?siteUrl=${encodeURIComponent(bingSiteUrl())}&apikey=${apiKey()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Bing ${method} failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { d?: RawStatRow[] };
  if (!Array.isArray(json.d)) {
    throw new Error(`Bing ${method}: unexpected response shape (no "d" array)`);
  }
  return json.d;
}

function toRows(raw: RawStatRow[], method: string): BingStatRow[] {
  const out: BingStatRow[] = [];
  for (const r of raw) {
    const key = (r.Query ?? "").trim();
    if (!key || !r.Date) continue;
    const bucketDate = parseBingDate(r.Date);
    if (!bucketDate) continue;
    const pos = r.AvgImpressionPosition;
    out.push({
      key,
      bucketDate,
      clicks: typeof r.Clicks === "number" && r.Clicks > 0 ? r.Clicks : 0,
      impressions:
        typeof r.Impressions === "number" && r.Impressions > 0 ? r.Impressions : 0,
      position: typeof pos === "number" && pos >= 0 ? pos : null,
    });
  }
  if (raw.length > 0 && out.length === 0) {
    throw new Error(`Bing ${method}: ${raw.length} rows but none parseable`);
  }
  return out;
}

/** Page-level stats (~6-month window; `key` holds the page URL). */
export async function fetchBingPageStats(): Promise<BingStatRow[]> {
  return toRows(await callBing("GetPageStats"), "GetPageStats");
}

/** Query-level stats (~6-month window; `key` holds the search query). */
export async function fetchBingQueryStats(): Promise<BingStatRow[]> {
  return toRows(await callBing("GetQueryStats"), "GetQueryStats");
}
