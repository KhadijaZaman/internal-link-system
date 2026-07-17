interface CruxMetricEntry {
  histogram?: Array<{ start?: number | string; end?: number | string; density?: number }>;
  percentiles?: { p75?: number | string };
}

interface CruxRecord {
  key?: { url?: string; origin?: string; formFactor?: string };
  metrics?: Record<string, CruxMetricEntry>;
}

interface CruxResponse {
  record?: CruxRecord;
}

export type Band = "good" | "ni" | "poor" | "unknown";

const THRESHOLDS: Record<string, { good: number; poor: number; lowerIsBetter: boolean }> = {
  largest_contentful_paint: { good: 2500, poor: 4000, lowerIsBetter: true },
  cumulative_layout_shift: { good: 0.1, poor: 0.25, lowerIsBetter: true },
  interaction_to_next_paint: { good: 200, poor: 500, lowerIsBetter: true },
  first_contentful_paint: { good: 1800, poor: 3000, lowerIsBetter: true },
  experimental_time_to_first_byte: { good: 800, poor: 1800, lowerIsBetter: true },
};

export function bandFor(metric: string, p75: number): Band {
  const t = THRESHOLDS[metric];
  if (!t) return "unknown";
  if (p75 <= t.good) return "good";
  if (p75 <= t.poor) return "ni";
  return "poor";
}

export interface CruxMetric {
  metric: string;
  p75: number;
  band: Band;
  distribution: Array<{ label: string; density: number }>;
}

export interface CruxFormFactor {
  formFactor: "PHONE" | "DESKTOP" | "ALL_FORM_FACTORS";
  metrics: CruxMetric[];
}

function num(v: number | string | undefined): number {
  if (v === undefined) return 0;
  return typeof v === "string" ? Number(v) : v;
}

function parseRecord(record: CruxRecord, formFactor: CruxFormFactor["formFactor"]): CruxFormFactor {
  const metrics: CruxMetric[] = [];
  for (const [name, m] of Object.entries(record.metrics ?? {})) {
    const p75 = num(m.percentiles?.p75);
    const distribution = (m.histogram ?? []).map((h) => ({
      label: `${num(h.start)}–${num(h.end) || "∞"}`,
      density: h.density ?? 0,
    }));
    metrics.push({ metric: name, p75, band: bandFor(name, p75), distribution });
  }
  return { formFactor, metrics };
}

export async function fetchCrux(target: { origin?: string; url?: string }): Promise<{
  formFactors: CruxFormFactor[];
  notice: string | null;
}> {
  const apiKey = process.env["CRUX_API_KEY"];
  if (!apiKey) {
    return {
      formFactors: [],
      notice: "Set CRUX_API_KEY (Google Cloud API key with Chrome UX Report API enabled) to see Core Web Vitals.",
    };
  }

  const formFactors: CruxFormFactor["formFactor"][] = ["PHONE", "DESKTOP", "ALL_FORM_FACTORS"];
  const results: CruxFormFactor[] = [];
  let lastError: string | null = null;

  for (const ff of formFactors) {
    try {
      const body: Record<string, unknown> = { formFactor: ff };
      if (target.url) body["url"] = target.url;
      else if (target.origin) body["origin"] = target.origin;
      else continue;

      const res = await fetch(
        `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        if (res.status === 404) continue; // no data for this form factor
        lastError = `CrUX ${ff} returned ${res.status}`;
        continue;
      }
      const data = (await res.json()) as CruxResponse;
      if (data.record) results.push(parseRecord(data.record, ff));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    formFactors: results,
    notice: results.length === 0 ? (lastError ?? "No CrUX data for this scope (origin may have insufficient traffic).") : null,
  };
}
