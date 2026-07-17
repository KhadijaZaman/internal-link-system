export interface SerpResult {
  rank: number;
  url: string;
  title: string;
  description: string;
}

export interface ReferringDomain {
  domain: string;
  backlinks: number;
  rank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export async function fetchTopReferringDomains(
  target: string,
  limit = 50,
): Promise<ReferringDomain[]> {
  const login = process.env["DATAFORSEO_LOGIN"];
  const password = process.env["DATAFORSEO_PASSWORD"];
  if (!login || !password) return [];
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const res = await fetch(
    "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          target,
          limit,
          mode: "as_is",
          order_by: ["backlinks,desc"],
        },
      ]),
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          domain?: string;
          backlinks?: number;
          rank?: number;
          first_seen?: string;
          last_seen?: string;
        }>;
      }>;
    }>;
  };
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .filter((i): i is Required<Pick<typeof i, "domain">> & typeof i => !!i.domain)
    .map((i) => ({
      domain: i.domain ?? "",
      backlinks: i.backlinks ?? 0,
      rank: i.rank ?? null,
      firstSeen: i.first_seen ?? null,
      lastSeen: i.last_seen ?? null,
    }));
}

export interface DfsPageContent {
  url: string;
  title: string;
  h1: string | null;
  excerpt: string;
  bodyText: string;
  wordCount: number;
  source: "dataforseo";
}

/**
 * Fetch and parse a page using DataForSEO's on-page content parser.
 * Use as a fallback when the in-house fetcher fails (JS-heavy / bot-blocked).
 * Pay-per-call: only invoke after in-house attempt.
 */
export async function fetchPageContentViaDataForSeo(
  url: string,
): Promise<DfsPageContent> {
  const login = process.env["DATAFORSEO_LOGIN"];
  const password = process.env["DATAFORSEO_PASSWORD"];
  if (!login || !password) {
    throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD must be set for fallback fetch");
  }
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const res = await fetch(
    "https://api.dataforseo.com/v3/on_page/content_parsing/live",
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ url, enable_javascript: true }]),
    },
  );
  if (!res.ok) throw new Error(`DataForSEO content_parsing HTTP ${res.status}`);
  const data = (await res.json()) as {
    tasks?: Array<{
      status_code?: number;
      status_message?: string;
      result?: Array<{
        items?: Array<{
          page_as_parsed?: {
            title?: string | null;
            meta?: { description?: string | null };
            h1?: Array<{ text?: string }>;
            text?: string;
            plain_text_word_count?: number;
          };
        }>;
      }>;
    }>;
  };
  const task = data.tasks?.[0];
  if (!task) throw new Error("DataForSEO returned no task");
  if (task.status_code && task.status_code >= 40000) {
    throw new Error(`DataForSEO task error: ${task.status_message ?? task.status_code}`);
  }
  const parsed = task.result?.[0]?.items?.[0]?.page_as_parsed;
  if (!parsed) throw new Error("DataForSEO returned no parsed page");
  const title = parsed.title?.trim() ?? "";
  const h1 = parsed.h1?.[0]?.text?.trim() ?? null;
  const excerpt = parsed.meta?.description?.trim() ?? "";
  const bodyText = (parsed.text ?? "").replace(/\s+/g, " ").trim();
  const wordCount = parsed.plain_text_word_count ?? (bodyText ? bodyText.split(/\s+/).length : 0);
  if (!bodyText || wordCount < 10) {
    throw new Error(`DataForSEO parsed page is empty (${wordCount} words)`);
  }
  return { url, title, h1, excerpt, bodyText, wordCount, source: "dataforseo" };
}

export interface SearchVolumeResult {
  query: string;
  /** Monthly search volume from Google Ads, or null if unknown. */
  searchVolume: number | null;
}

/**
 * Fetch monthly Google Ads search volume for up to 1000 queries in a single
 * DataForSEO call. Returns one entry per **successfully answered** query;
 * queries the API didn't answer (transport error, missing creds, task-level
 * failure, batch-level HTTP error) are omitted so the caller can leave the
 * cache stale and retry next run. A query that DataForSEO actively answered
 * with "no measurable volume" is returned with `searchVolume: null` — that
 * IS a successful answer and should be cached.
 *
 * Endpoint: keywords_data/google_ads/search_volume/live (paid).
 */
export async function fetchSearchVolumes(
  queries: string[],
): Promise<SearchVolumeResult[]> {
  const login = process.env["DATAFORSEO_LOGIN"];
  const password = process.env["DATAFORSEO_PASSWORD"];
  if (!login || !password || queries.length === 0) return [];
  // DataForSEO caps each task at 1000 keywords.
  const out: SearchVolumeResult[] = [];
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  for (let i = 0; i < queries.length; i += 1000) {
    const batch = queries.slice(i, i + 1000);
    try {
      const res = await fetch(
        "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            {
              keywords: batch,
              language_code: "en",
              location_code: 2840,
              search_partners: false,
            },
          ]),
        },
      );
      if (!res.ok) continue; // transport failure — skip batch so it retries
      const data = (await res.json()) as {
        tasks?: Array<{
          status_code?: number;
          result?: Array<{
            keyword?: string;
            search_volume?: number | null;
          }>;
        }>;
      };
      const task = data.tasks?.[0];
      // Task-level failure — DataForSEO returns 4xxxx/5xxxx status codes on
      // the task itself. Don't pretend we got answers we didn't.
      if (!task || (task.status_code ?? 20000) >= 40000) continue;
      for (const r of task.result ?? []) {
        if (typeof r.keyword === "string") {
          out.push({
            query: r.keyword,
            searchVolume: r.search_volume ?? null,
          });
        }
      }
    } catch {
      // network/parse error — skip batch
      continue;
    }
  }
  return out;
}

export async function fetchSerpTop5(query: string): Promise<SerpResult[]> {
  const login = process.env["DATAFORSEO_LOGIN"];
  const password = process.env["DATAFORSEO_PASSWORD"];
  if (!login || !password) {
    throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD must be set");
  }
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const res = await fetch(
    "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          language_code: "en",
          location_code: 2840,
          keyword: query,
          depth: 10,
        },
      ]),
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          type?: string;
          rank_absolute?: number;
          url?: string;
          title?: string;
          description?: string;
        }>;
      }>;
    }>;
  };
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .filter((i) => i.type === "organic")
    .slice(0, 5)
    .map((i, idx) => ({
      rank: i.rank_absolute ?? idx + 1,
      url: i.url ?? "",
      title: i.title ?? "",
      description: i.description ?? "",
    }));
}
