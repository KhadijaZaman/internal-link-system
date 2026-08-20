import { expectedCtrFor } from "../lib/insights";

export const ROADMAP_TAB_TITLE = "Optimization Roadmap";
export const FRESHNESS_TAB_TITLE = "Data Freshness";
export const CENTRAL_ENTITY = "AI Search Visibility";
export const CENTRAL_PAGE_PATH = "/blog/search-engine-visibility";

export interface RoadmapMetrics {
  path: string;
  url: string;
  title: string | null;
  gscImpressions: number | null;
  gscClicks: number | null;
  gscCtr: number | null;
  gscPosition: number | null;
  gscTopQuery: string | null;
  ga4Sessions: number | null;
  ga4EngagementRate: number | null;
  ga4AvgEngagementTime: number | null;
  ga4KeyEvents: number | null;
  ga4AiSessions: number | null;
  bingImpressions: number | null;
  bingClicks: number | null;
  bingPosition: number | null;
  aiCitations: number | null;
  aiPromptInstances: number | null;
  contentInboundLinks: number | null;
  contentOutboundLinks: number | null;
}

export interface RoadmapScore {
  score: number;
  priorityTier: string;
  lowHangingFruit: boolean;
  reason: string;
}

export interface RoadmapTaxonomy {
  topicCluster: string;
  clusterRole: "Central page" | "Supporting page" | "Adjacent page" | "Outside core cluster";
}

export interface RoadmapSourceFreshness {
  source: "GSC" | "GA4" | "Bing" | "AI citations" | "Content links";
  state: "fresh" | "stale" | "missing";
  windowStart: string | null;
  windowEnd: string | null;
  observedAt: string | null;
  detail: string;
}

export interface CitationWindow {
  isThirtyDay: boolean;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface RoadmapColumnPlan {
  headers: string[];
  columns: Array<{ columnIndex: number; header: string; values: Array<string | number | boolean> }>;
  addedHeaders: string[];
}

interface DynamicColumn {
  header: string;
  aliases: string[];
  value: (
    metric: RoadmapMetrics,
    score: RoadmapScore,
    taxonomy: RoadmapTaxonomy,
    refreshedAt: string,
    freshness: ReadonlyMap<RoadmapSourceFreshness["source"], RoadmapSourceFreshness>,
  ) => string | number | boolean;
  fillOnly?: boolean;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeRoadmapPath(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null;
  path = (path.split("?")[0] ?? path).split("#")[0] ?? path;
  path = path.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

/**
 * Citation uploads are immutable but their schema predates report-window
 * metadata. Accept an explicit 30-day label, or two ISO dates spanning 29–31
 * inclusive days; otherwise callers must label the source stale/unverified.
 */
export function inferCitationWindow(label: string): CitationWindow {
  const dates = [...label.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(
    (match) => match[1]!,
  );
  if (dates.length >= 2) {
    const sorted = dates.slice(0, 2).sort();
    const start = new Date(`${sorted[0]}T00:00:00Z`);
    const end = new Date(`${sorted[1]}T00:00:00Z`);
    const inclusiveDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (inclusiveDays >= 29 && inclusiveDays <= 31) {
      return {
        isThirtyDay: true,
        windowStart: sorted[0]!,
        windowEnd: sorted[1]!,
      };
    }
  }
  return {
    isThirtyDay: /\b30[\s_-]*(?:d|day|days)\b/i.test(label),
    windowStart: null,
    windowEnd: null,
  };
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

/**
 * Deterministic taxonomy for previously-unclassified rows. Existing sheet
 * values are fill-only, so reviewed classifications never drift on refresh.
 */
export function classifyRoadmapPage(input: {
  path: string;
  title?: string | null;
  topQuery?: string | null;
}): RoadmapTaxonomy {
  const path = normalizeRoadmapPath(input.path) ?? input.path.toLowerCase();
  const rawText = `${path} ${input.title ?? ""} ${input.topQuery ?? ""}`.toLowerCase();
  const text = `${rawText} ${rawText.replace(/[-_/]+/g, " ")}`;

  let topicCluster: string;
  if (path === CENTRAL_PAGE_PATH) {
    topicCluster = "AI Search Visibility";
  } else if (
    /ai-search-visibility-for-[a-z-]+-brands/.test(path) ||
    containsAny(text, ["industry", "brands in", "for healthcare", "for banking"])
  ) {
    topicCluster = "Industry AI Visibility";
  } else if (
    containsAny(text, [
      "ai search visibility",
      "search visibility",
      "ai visibility",
      "visible in ai",
    ])
  ) {
    topicCluster = "AI Search Visibility";
  } else if (
    containsAny(text, [
      "generative engine optimization",
      "/geo",
      " geo ",
      "answer engine optimization",
      "/aeo",
      "seo-vs-geo",
    ])
  ) {
    topicCluster = "Generative & Answer Engine Optimization";
  } else if (
    containsAny(text, [
      "citation",
      "brand mention",
      "llm mention",
      "cited source",
      "digital-pr",
      "seo-outreach",
    ])
  ) {
    topicCluster = "AI Citations, Mentions & Digital PR";
  } else if (
    containsAny(text, [
      "chatgpt",
      "perplexity",
      "gemini",
      "claude",
      "copilot",
      "ai overview",
      "ai mode",
    ])
  ) {
    topicCluster = "AI Platform Visibility";
  } else if (
    containsAny(text, [
      "tracking",
      "monitoring",
      "measurement",
      "reporting",
      "analytics",
      "performance history",
      "visibility score",
    ])
  ) {
    topicCluster = "AI Visibility Tracking & Analytics";
  } else if (
    containsAny(text, [
      "internal-link",
      "internal link",
      "topic cluster",
      "topical authority",
      "knowledge graph",
      "entity",
      "semantic",
    ])
  ) {
    topicCluster = "Topical Authority & Internal Linking";
  } else if (
    containsAny(text, [
      "content",
      "writing",
      "humanizer",
      "readability",
      "brand voice",
      "content brief",
    ])
  ) {
    topicCluster = "Content Strategy & Creation";
  } else if (
    containsAny(text, [
      "/alternatives/",
      " alternative",
      " vs ",
      "-vs-",
      "/teardown/",
      "comparison",
    ])
  ) {
    topicCluster = "Comparisons, Alternatives & Teardowns";
  } else if (containsAny(text, ["/solutions/agenc", " agency", " agencies", "consultant", "freelancer"])) {
    topicCluster = "Agencies & Marketing Services";
  } else if (containsAny(text, ["/solutions/startup", " startup", "saas", "entrepreneur"])) {
    topicCluster = "Startup & SaaS Growth";
  } else if (containsAny(text, ["/features", "/pricing", "/start-free", "/book-a-demo", "wellows"])) {
    topicCluster = "Wellows Product & Commercial";
  } else if (containsAny(text, ["/tools", " checklist", " template", " generator", " tracker"])) {
    topicCluster = "Tools, Checklists & Templates";
  } else if (
    containsAny(text, [
      "technical seo",
      "on-page seo",
      "keyword",
      "serp",
      "search engine",
      "meta tag",
      "crawl",
      "index",
    ])
  ) {
    topicCluster = "SEO Foundations & Search Strategy";
  } else if (
    containsAny(text, [
      "llm",
      "large language model",
      "transformer",
      "attention mechanism",
      "machine learning",
      "artificial intelligence",
    ])
  ) {
    topicCluster = "AI & LLM Fundamentals";
  } else if (containsAny(text, ["/about", "/contact", "/affiliate", "/terms", "/privacy", "/updates"])) {
    topicCluster = "Company & Resources";
  } else {
    topicCluster = "Search & Content Growth";
  }

  let clusterRole: RoadmapTaxonomy["clusterRole"];
  if (path === CENTRAL_PAGE_PATH) {
    clusterRole = "Central page";
  } else if (
    containsAny(text, [
      "ai search visibility",
      "search visibility",
      "ai visibility",
      "generative engine optimization",
      "answer engine optimization",
      "citation",
      "chatgpt",
      "perplexity",
      "gemini",
      "ai overview",
      "knowledge graph",
      "entity",
    ])
  ) {
    clusterRole = "Supporting page";
  } else if (
    containsAny(text, [
      "seo",
      "content",
      "internal link",
      "topical authority",
      "brand",
      "digital pr",
      "keyword",
    ])
  ) {
    clusterRole = "Adjacent page";
  } else {
    clusterRole = "Outside core cluster";
  }

  return { topicCluster, clusterRole };
}

function round(value: number, decimals = 1): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function priorityFor(score: number): string {
  if (score >= 70) return "Tier 1 — Immediate win";
  if (score >= 50) return "Tier 2 — Growth opportunity";
  if (score >= 30) return "Tier 3 — Authority building";
  return "Tier 4 — Maintain / monitor";
}

/**
 * Evidence-weighted 0–100 opportunity score for the AI Visibility roadmap.
 * Observed performance determines opportunity within the core, while cluster
 * role is an eligibility gate: adjacent and outside-core pages retain their
 * evidence but cannot outrank the central entity or direct-support pages.
 */
export function scoreRoadmapOpportunity(
  metric: RoadmapMetrics,
  role: RoadmapTaxonomy["clusterRole"],
): RoadmapScore {
  const reasons: string[] = [];
  let score = 0;

  const gscEvidence = (metric.gscImpressions ?? 0) > 0;
  const bingEvidence = (metric.bingImpressions ?? 0) > 0;
  const citationEvidence =
    (metric.aiCitations ?? 0) > 0 || (metric.aiPromptInstances ?? 0) > 0;
  const engagementEvidence = (metric.ga4Sessions ?? 0) >= 20;
  const performanceEvidence = gscEvidence || bingEvidence || citationEvidence || engagementEvidence;

  if (gscEvidence) {
    score += Math.min(20, Math.log10(1 + (metric.gscImpressions ?? 0)) * 5);
    const position = metric.gscPosition;
    if (position !== null) {
      if (position > 3 && position <= 20) {
        score += 20;
        reasons.push(`GSC position ${round(position)} is within striking distance`);
      } else if (position > 20 && position <= 40) {
        score += 10;
        reasons.push(`GSC demand exists at position ${round(position)}`);
      } else if (position <= 3) {
        score += 3;
      } else {
        score += 4;
      }

      const expectedCtr = expectedCtrFor(position);
      if (
        expectedCtr !== null &&
        metric.gscCtr !== null &&
        metric.gscImpressions !== null &&
        metric.gscImpressions >= 100 &&
        metric.gscCtr < expectedCtr * 0.5
      ) {
        score += 15;
        reasons.push("CTR is below the position benchmark");
      }
    }
  }

  if (engagementEvidence && metric.ga4EngagementRate !== null && metric.ga4EngagementRate < 0.4) {
    score += 10;
    reasons.push("GA4 engagement is weak on meaningful traffic");
  }

  if (bingEvidence) {
    score += Math.min(8, Math.log10(1 + (metric.bingImpressions ?? 0)) * 2);
    if (
      metric.bingPosition !== null &&
      metric.bingPosition > 3 &&
      metric.bingPosition <= 20
    ) {
      score += 6;
      reasons.push(`Bing position ${round(metric.bingPosition)} is within striking distance`);
    }
  }

  if (citationEvidence) {
    score += Math.min(
      12,
      4 + Math.log10(1 + (metric.aiCitations ?? 0) + (metric.aiPromptInstances ?? 0)) * 4,
    );
    reasons.push("AI citation or prompt evidence confirms demand");
  }

  if (metric.contentInboundLinks !== null) {
    if (metric.contentInboundLinks <= 3) {
      score += 12;
      reasons.push("Content-only internal-link support is very low");
    } else if (metric.contentInboundLinks <= 7) {
      score += 6;
      reasons.push("Content-only internal-link support is limited");
    }
  }

  if (role === "Supporting page") score += 6;
  else if (role === "Central page") score += 4;
  else if (role === "Adjacent page") score += 2;

  const expectedCtr =
    metric.gscPosition === null ? null : expectedCtrFor(metric.gscPosition);
  const dominant =
    gscEvidence &&
    metric.gscPosition !== null &&
    metric.gscPosition <= 3 &&
    (expectedCtr === null ||
      metric.gscCtr === null ||
      metric.gscCtr >= expectedCtr * 0.7) &&
    (!engagementEvidence ||
      metric.ga4EngagementRate === null ||
      metric.ga4EngagementRate >= 0.5);
  if (dominant) {
    score -= 20;
    reasons.push("Already dominant; maintain rather than prioritize");
  }

  const nearPageOne =
    (metric.gscPosition !== null && metric.gscPosition > 3 && metric.gscPosition <= 20) ||
    (metric.bingPosition !== null && metric.bingPosition > 3 && metric.bingPosition <= 20);
  const ctrGap =
    gscEvidence &&
    metric.gscPosition !== null &&
    expectedCtrFor(metric.gscPosition) !== null &&
    metric.gscCtr !== null &&
    metric.gscCtr < (expectedCtrFor(metric.gscPosition) ?? 0) * 0.5;
  const engagementGap =
    engagementEvidence &&
    metric.ga4EngagementRate !== null &&
    metric.ga4EngagementRate < 0.4;
  const citationGap =
    citationEvidence && ((metric.gscClicks ?? 0) === 0 || (metric.ga4Sessions ?? 0) < 20);
  const linkGap = metric.contentInboundLinks !== null && metric.contentInboundLinks <= 3;
  const isAiVisibilityCore = role === "Central page" || role === "Supporting page";
  const lowHangingFruit =
    isAiVisibilityCore &&
    performanceEvidence &&
    !dominant &&
    (nearPageOne || ctrGap || engagementGap || citationGap || linkGap);

  const evidenceScore = Math.max(0, Math.min(100, Math.round(score)));
  const coreAdjustedScore =
    role === "Central page" && performanceEvidence
      ? Math.max(evidenceScore, 70)
      : evidenceScore;
  const finalScore = isAiVisibilityCore
    ? coreAdjustedScore
    : role === "Adjacent page"
      ? Math.min(evidenceScore, 49)
      : Math.min(evidenceScore, 29);
  const evidenceReason =
    reasons.slice(0, 6).join("; ") ||
    (performanceEvidence
      ? "No strong near-term gap; maintain and monitor"
      : "No current performance evidence; build authority before prioritizing");
  const relevanceReason =
    role === "Adjacent page"
      ? "Outside the AI Visibility core; retain only as a contextual-support opportunity"
      : role === "Outside core cluster"
        ? "Outside the AI Visibility core; exclude from the AI Visibility optimization queue"
        : null;

  return {
    score: finalScore,
    priorityTier: priorityFor(finalScore),
    lowHangingFruit,
    reason: relevanceReason ? `${relevanceReason}. ${evidenceReason}` : evidenceReason,
  };
}

function sourceDate(
  freshness: ReadonlyMap<RoadmapSourceFreshness["source"], RoadmapSourceFreshness>,
  source: RoadmapSourceFreshness["source"],
): string {
  const item = freshness.get(source);
  if (!item) return "Missing";
  const date = item.windowEnd ?? item.observedAt;
  const suffix = item.state === "fresh" ? "" : ` (${item.state})`;
  return date ? `${date}${suffix}` : `${item.state}: ${item.detail}`;
}

const DYNAMIC_COLUMNS: DynamicColumn[] = [
  {
    header: "Topic Cluster",
    aliases: ["primary topic cluster"],
    fillOnly: true,
    value: (_metric, _score, taxonomy) => taxonomy.topicCluster,
  },
  {
    header: "AI Visibility Cluster Role",
    aliases: ["cluster role", "ai visibility role", "central entity role"],
    fillOnly: true,
    value: (_metric, _score, taxonomy) => taxonomy.clusterRole,
  },
  {
    header: "GSC Impressions (30d)",
    aliases: ["gsc impressions", "google impressions", "impressions 30d"],
    value: (m) => m.gscImpressions ?? "",
  },
  {
    header: "GSC Clicks (30d)",
    aliases: ["gsc clicks", "google clicks", "clicks 30d"],
    value: (m) => m.gscClicks ?? "",
  },
  {
    header: "GSC CTR (30d)",
    aliases: ["gsc ctr", "google ctr", "ctr 30d"],
    value: (m) => (m.gscCtr === null ? "" : round(m.gscCtr, 4)),
  },
  {
    header: "GSC Avg Position (30d)",
    aliases: ["gsc avg position", "gsc position", "google position"],
    value: (m) => (m.gscPosition === null ? "" : round(m.gscPosition, 2)),
  },
  {
    header: "GSC Top Query (30d)",
    aliases: ["gsc top query", "top query"],
    value: (m) => m.gscTopQuery ?? "",
  },
  {
    header: "GA4 Sessions (30d)",
    aliases: ["ga4 sessions", "sessions 30d"],
    value: (m) => m.ga4Sessions ?? "",
  },
  {
    header: "GA4 Engagement Rate (30d)",
    aliases: ["ga4 engagement rate", "engagement rate"],
    value: (m) => (m.ga4EngagementRate === null ? "" : round(m.ga4EngagementRate, 4)),
  },
  {
    header: "GA4 Avg Engagement Time (30d)",
    aliases: ["ga4 avg engagement time", "average engagement time"],
    value: (m) =>
      m.ga4AvgEngagementTime === null ? "" : round(m.ga4AvgEngagementTime, 1),
  },
  {
    header: "GA4 Key Events (30d)",
    aliases: ["ga4 key events", "key events", "conversions"],
    value: (m) => m.ga4KeyEvents ?? "",
  },
  {
    header: "GA4 AI Sessions (30d)",
    aliases: ["ga4 ai sessions", "ai sessions"],
    value: (m) => m.ga4AiSessions ?? "",
  },
  {
    header: "Bing Impressions (30d)",
    aliases: ["bing impressions"],
    value: (m) => m.bingImpressions ?? "",
  },
  {
    header: "Bing Clicks (30d)",
    aliases: ["bing clicks"],
    value: (m) => m.bingClicks ?? "",
  },
  {
    header: "Bing Avg Position (30d)",
    aliases: ["bing avg position", "bing position"],
    value: (m) => (m.bingPosition === null ? "" : round(m.bingPosition, 2)),
  },
  {
    header: "AI Citations (latest upload)",
    aliases: [
      "ai citations",
      "ai citations latest 30d upload",
      "explicit citations",
      "wellows explicit citations",
    ],
    value: (m) => m.aiCitations ?? "",
  },
  {
    header: "AI Prompt Instances (latest upload)",
    aliases: [
      "ai prompt instances",
      "ai prompt instances latest 30d upload",
      "prompt instances",
    ],
    value: (m) => m.aiPromptInstances ?? "",
  },
  {
    header: "Content Internal Backlinks",
    aliases: ["content internal backlinks count", "content backlinks", "internal backlinks"],
    value: (m) => m.contentInboundLinks ?? "",
  },
  {
    header: "Content Internal Links",
    aliases: ["content internal links count", "content outbound links", "internal links"],
    value: (m) => m.contentOutboundLinks ?? "",
  },
  {
    header: "Optimization Opportunity Score",
    aliases: ["opportunity score", "optimization score"],
    value: (_m, score) => score.score,
  },
  {
    header: "Priority Tier",
    aliases: ["optimization priority", "priority"],
    value: (_m, score) => score.priorityTier,
  },
  {
    header: "Low-Hanging Fruit",
    aliases: ["low hanging fruit", "low hanging fruit flag"],
    value: (_m, score) => (score.lowHangingFruit ? "Yes" : "No"),
  },
  {
    header: "Opportunity Reason",
    aliases: ["priority reason", "optimization reason"],
    value: (_m, score) => score.reason,
  },
  {
    header: "GSC Data Through",
    aliases: [],
    value: (_m, _s, _t, _r, freshness) => sourceDate(freshness, "GSC"),
  },
  {
    header: "GA4 Data Through",
    aliases: [],
    value: (_m, _s, _t, _r, freshness) => sourceDate(freshness, "GA4"),
  },
  {
    header: "Bing Data Through",
    aliases: [],
    value: (_m, _s, _t, _r, freshness) => sourceDate(freshness, "Bing"),
  },
  {
    header: "Citation Data As Of",
    aliases: [],
    value: (_m, _s, _t, _r, freshness) => sourceDate(freshness, "AI citations"),
  },
  {
    header: "Link Data As Of",
    aliases: [],
    value: (_m, _s, _t, _r, freshness) => sourceDate(freshness, "Content links"),
  },
  {
    header: "Roadmap Refreshed At",
    aliases: ["last refreshed", "refreshed at"],
    value: (_m, _s, _t, refreshedAt) => refreshedAt,
  },
];

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const wanted = new Set(candidates.map(normalizeHeader));
  return headers.findIndex((header) => wanted.has(normalizeHeader(header)));
}

export function findRoadmapKeyColumn(headers: string[]): number {
  return findHeaderIndex(headers, ["Path", "Page Path", "URL", "Page URL"]);
}

/**
 * Builds column-oriented updates so Sheets can rewrite only managed columns.
 * Unknown/manual columns and row order are never touched.
 */
export function buildRoadmapColumnPlan(input: {
  headers: string[];
  rows: Array<Array<string | number | boolean>>;
  metricsByPath: ReadonlyMap<string, RoadmapMetrics>;
  refreshedAt: string;
  freshness: RoadmapSourceFreshness[];
}): RoadmapColumnPlan {
  const headers = [...input.headers];
  const keyColumn = findRoadmapKeyColumn(headers);
  if (keyColumn < 0) {
    throw new Error("Roadmap tab must contain a Path or URL column");
  }

  const freshness = new Map(input.freshness.map((source) => [source.source, source]));
  const roleColumn = findHeaderIndex(headers, [
    "AI Visibility Cluster Role",
    "Cluster Role",
    "AI Visibility Role",
    "Central Entity Role",
  ]);
  const addedHeaders: string[] = [];
  const columns: RoadmapColumnPlan["columns"] = [];

  for (const spec of DYNAMIC_COLUMNS) {
    let columnIndex = findHeaderIndex(headers, [spec.header, ...spec.aliases]);
    if (columnIndex < 0) {
      columnIndex = headers.length;
      headers.push(spec.header);
      addedHeaders.push(spec.header);
    }

    const values = input.rows.map((row) => {
      if (spec.fillOnly) {
        const current = row[columnIndex];
        if (current !== undefined && String(current).trim() !== "") return current;
      }
      const path = normalizeRoadmapPath(String(row[keyColumn] ?? ""));
      const metric = path ? input.metricsByPath.get(path) : undefined;
      if (!metric) return "";
      const taxonomy = classifyRoadmapPage({
        path: metric.path,
        title: metric.title,
        topQuery: metric.gscTopQuery,
      });
      const reviewedRole = roleColumn >= 0 ? String(row[roleColumn] ?? "").trim() : "";
      if (
        reviewedRole === "Central page" ||
        reviewedRole === "Supporting page" ||
        reviewedRole === "Adjacent page" ||
        reviewedRole === "Outside core cluster"
      ) {
        taxonomy.clusterRole = reviewedRole;
      }
      const score = scoreRoadmapOpportunity(metric, taxonomy.clusterRole);
      return spec.value(metric, score, taxonomy, input.refreshedAt, freshness);
    });

    columns.push({ columnIndex, header: headers[columnIndex] ?? spec.header, values });
  }

  return { headers, columns, addedHeaders };
}
