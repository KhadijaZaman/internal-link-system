/**
 * Rule-based action plan for a tracked URL — pure, db-free, zero paid work.
 *
 * Every rule imports its thresholds from lib/insights.ts (the single source
 * of truth for SEO insight rules) so the plan can never disagree with the
 * page-report verdicts. Each action carries a plain-English "why" with the
 * actual numbers behind the rule so a non-technical operator can trust it.
 */
import {
  ctrInsight,
  CTR_MIN_MISSED_CLICKS,
  WEAK_ENGAGEMENT_RATE,
  ENGAGEMENT_MIN_SESSIONS,
  CONVERSION_MIN_IMPRESSIONS,
} from "./insights";

export type ActionPriority = "do_first" | "next" | "later";

export interface TrackedActionItem {
  id: string;
  priority: ActionPriority;
  title: string;
  why: string;
  steps: string[];
  link: string | null;
  linkLabel: string | null;
}

export interface GscTotalsIn {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface ActionPlanInput {
  url: string;
  keyword: string | null;
  days: number;
  gsc: {
    overallTotals: GscTotalsIn;
    keywordTotals: GscTotalsIn | null;
    topQueries: {
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
      isTracked: boolean;
    }[];
  } | null;
  indexing: {
    verdict: string | null;
    coverageState: string | null;
    robotsTxtState: string | null;
    pageFetchState: string | null;
  } | null;
  bing: { connected: boolean; clicks: number; impressions: number } | null;
  ga4: {
    sessions: number;
    engagementRate: number;
    keyEvents: number;
    aiSessions: number;
  } | null;
  aiCitations: { hasUpload: boolean; citations: number } | null;
  /** Other own URLs competing for the tracked keyword (self excluded). */
  cannibalizedWith: string[];
}

/** Positions 11-20 — page two, one push away from real traffic. */
export const STRIKING_MIN_POSITION = 11;
export const STRIKING_MAX_POSITION = 20;
/** Impressions needed before "striking distance" is a signal, not noise. */
export const STRIKING_MIN_IMPRESSIONS = 20;
/** Google impressions needed before "invisible on Bing" is worth flagging. */
export const BING_GAP_MIN_GOOGLE_IMPRESSIONS = 100;
/** Top query must beat the tracked keyword by this factor to flag a mismatch. */
export const MISMATCH_RATIO = 2;
/** Top query needs at least this many impressions to flag a mismatch. */
export const MISMATCH_MIN_IMPRESSIONS = 50;

const PRIORITY_ORDER: Record<ActionPriority, number> = {
  do_first: 0,
  next: 1,
  later: 2,
};

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function buildActionPlan(input: ActionPlanInput): TrackedActionItem[] {
  const { url, keyword, days, gsc, indexing, bing, ga4, aiCitations, cannibalizedWith } = input;
  const actions: TrackedActionItem[] = [];

  // 1. Indexing problem — nothing else matters until Google can index the page.
  if (indexing && indexing.verdict && indexing.verdict !== "PASS") {
    const state = indexing.coverageState ?? indexing.verdict;
    const steps: string[] = [];
    if (indexing.robotsTxtState && indexing.robotsTxtState !== "ALLOWED") {
      steps.push(
        "Your robots.txt file is blocking Google from this page — remove the block first.",
      );
    }
    if (indexing.pageFetchState && indexing.pageFetchState !== "SUCCESSFUL") {
      steps.push(
        `Google couldn't fetch the page (status: ${indexing.pageFetchState}) — make sure the URL loads without errors or redirects.`,
      );
    }
    steps.push(
      "Add internal links to this page from related pages that are already indexed.",
      'Open the URL in Google Search Console and click "Request indexing".',
      "Confirm the page is listed in your sitemap.",
    );
    actions.push({
      id: "fix_indexing",
      priority: "do_first",
      title: "Get this page indexed by Google",
      why: `Google reports this page as "${state}" — until it's indexed it can't appear in search results at all.`,
      steps,
      link: null,
      linkLabel: null,
    });
  }

  // Pick the measurement scope: the tracked keyword when it has data,
  // otherwise the page overall.
  const kwTotals = gsc?.keywordTotals ?? null;
  const useKeyword = kwTotals !== null && kwTotals.impressions > 0;
  const scope = useKeyword ? kwTotals : (gsc?.overallTotals ?? null);
  const scopeLabel = useKeyword ? `your keyword "${keyword}"` : "this page";

  // 2. Striking distance — position 11-20 with real impressions.
  if (
    scope &&
    scope.position >= STRIKING_MIN_POSITION &&
    scope.position <= STRIKING_MAX_POSITION &&
    scope.impressions >= STRIKING_MIN_IMPRESSIONS
  ) {
    actions.push({
      id: "push_top10",
      priority: "do_first",
      title: "Push into the top 10 with internal links",
      why: `Over the last ${days} days ${scopeLabel} ranked at position ${scope.position.toFixed(1)} with ${fmt(scope.impressions)} impressions — just outside the top 10, where almost all clicks happen.`,
      steps: [
        "Add internal links to this page from your strongest related pages.",
        "Use the keyword (or a close variation) as the link text.",
        "Refresh the content so it fully answers the search — compare it against the pages ranking above you.",
      ],
      link: `/link-map?url=${encodeURIComponent(url)}`,
      linkLabel: "See internal link opportunities",
    });
  }

  // 3. Ranks well but loses the click — title/description rewrite.
  if (scope) {
    const ins = ctrInsight(scope.position, scope.ctr, scope.impressions);
    if (ins.ctrFlag === "underperforming" && ins.missedClicks >= CTR_MIN_MISSED_CLICKS) {
      actions.push({
        id: "rewrite_snippet",
        priority: "do_first",
        title: "Rewrite the title and description to win the click",
        why: `${scopeLabel[0].toUpperCase()}${scopeLabel.slice(1)} ranks at position ${scope.position.toFixed(1)} but only ${(scope.ctr * 100).toFixed(1)}% of people click — roughly ${(ins.expectedCtr! * 100).toFixed(1)}% is normal for that spot. That's about ${fmt(ins.missedClicks)} missed clicks in the last ${days} days.`,
        steps: [
          "Rewrite the page title to make the benefit obvious and include the keyword.",
          "Rewrite the meta description as a one-sentence pitch with a reason to click.",
          "Check how your result looks in Google — does it stand out next to the competition?",
        ],
        link: null,
        linkLabel: null,
      });
    }
  }

  // 4. Tracked keyword invisible — Google doesn't show the page for it yet.
  if (keyword && gsc && (kwTotals === null || kwTotals.impressions === 0)) {
    actions.push({
      id: "keyword_invisible",
      priority: "next",
      title: `Google isn't showing this page for "${keyword}" yet`,
      why: `In the last ${days} days this page got zero impressions for your target keyword — Google doesn't associate the page with it yet.`,
      steps: [
        "Make sure the keyword appears in the page title and main heading.",
        "Use the keyword as link text in internal links pointing to this page.",
        "Cover the questions people searching that keyword actually have.",
      ],
      link: null,
      linkLabel: null,
    });
  }

  // 5. Keyword mismatch — the page mostly ranks for a different search.
  if (keyword && useKeyword && gsc) {
    const topOther = gsc.topQueries.find((q) => !q.isTracked);
    const topIsOther = gsc.topQueries.length > 0 && !gsc.topQueries[0].isTracked;
    if (
      topIsOther &&
      topOther &&
      topOther.impressions >= MISMATCH_MIN_IMPRESSIONS &&
      topOther.impressions >= kwTotals!.impressions * MISMATCH_RATIO
    ) {
      actions.push({
        id: "align_content",
        priority: "next",
        title: "The page ranks for a different search than your keyword",
        why: `Google shows this page mostly for "${topOther.query}" (${fmt(topOther.impressions)} impressions) — ${MISMATCH_RATIO}x more than your keyword "${keyword}" (${fmt(kwTotals!.impressions)}). Google may see the page as being about something else.`,
        steps: [
          `Decide which search matters more to you: "${keyword}" or "${topOther.query}".`,
          "If you want the tracked keyword: make it more prominent in the title, headings, and opening paragraph.",
          "If the other search is actually valuable: consider tracking that keyword instead.",
        ],
        link: null,
        linkLabel: null,
      });
    }
  }

  // 6. Cannibalization — own pages competing for the same keyword.
  if (cannibalizedWith.length > 0) {
    const shown = cannibalizedWith.slice(0, 3).join(", ");
    actions.push({
      id: "consolidate_pages",
      priority: "next",
      title: "Your own pages are competing for the same keyword",
      why: `${fmt(cannibalizedWith.length + 1)} of your pages show up for the same search (${shown}${cannibalizedWith.length > 3 ? ", …" : ""}) — they split clicks and confuse Google about which one should rank.`,
      steps: [
        "Pick ONE page to be the main answer for this keyword.",
        "Link from the other pages to the main one using the keyword as link text.",
        "If two pages say nearly the same thing, merge them and redirect the weaker one.",
      ],
      link: null,
      linkLabel: null,
    });
  }

  // 7. Weak engagement — Google sends visitors, the page loses them.
  if (ga4 && ga4.sessions >= ENGAGEMENT_MIN_SESSIONS && ga4.engagementRate < WEAK_ENGAGEMENT_RATE) {
    actions.push({
      id: "improve_engagement",
      priority: "next",
      title: "Visitors leave the page too quickly",
      why: `Only ${(ga4.engagementRate * 100).toFixed(0)}% of the ${fmt(ga4.sessions)} visits in this window were engaged — below the ${(WEAK_ENGAGEMENT_RATE * 100).toFixed(0)}% healthy mark. People arrive but don't find what they expected.`,
      steps: [
        "Answer the search question in the first screen — don't bury it.",
        "Break up long text with headings, bullets, and images.",
        "Check the page loads fast and reads well on a phone.",
      ],
      link: null,
      linkLabel: null,
    });
  }

  // 8. Traffic but zero conversions — missing call to action.
  if (
    gsc &&
    ga4 &&
    gsc.overallTotals.impressions >= CONVERSION_MIN_IMPRESSIONS &&
    ga4.sessions >= ENGAGEMENT_MIN_SESSIONS &&
    ga4.keyEvents === 0
  ) {
    actions.push({
      id: "add_cta",
      priority: "later",
      title: "Real traffic, but no signups or bookings",
      why: `The page had ${fmt(gsc.overallTotals.impressions)} impressions and ${fmt(ga4.sessions)} visits in this window, but zero key events (signups or demo bookings).`,
      steps: [
        "Add one clear call to action near the top of the page.",
        "Match the offer to what the visitor searched for.",
        "Repeat the call to action at the end of the page.",
      ],
      link: null,
      linkLabel: null,
    });
  }

  // 9. AI assistants mention it, Google sends nothing.
  const aiSignal = (ga4?.aiSessions ?? 0) > 0 || (aiCitations?.citations ?? 0) > 0;
  if (aiSignal && gsc && gsc.overallTotals.clicks === 0) {
    const parts: string[] = [];
    if ((aiCitations?.citations ?? 0) > 0) parts.push(`${fmt(aiCitations!.citations)} AI citations`);
    if ((ga4?.aiSessions ?? 0) > 0) parts.push(`${fmt(ga4!.aiSessions)} visits from AI assistants`);
    actions.push({
      id: "ai_no_google",
      priority: "later",
      title: "AI assistants cite this page, but Google sends no clicks",
      why: `The page earned ${parts.join(" and ")}, yet zero Google clicks in this window — AI tools find it useful while it's invisible or unclicked in normal search.`,
      steps: [
        "Check the indexing section above — is the page indexed at all?",
        "If it ranks but gets no clicks, rewrite the title and description.",
        "Keep the content fresh — AI visibility is a strong quality signal worth building on.",
      ],
      link: null,
      linkLabel: null,
    });
  }

  // 10. Visible on Google, invisible on Bing.
  if (
    bing &&
    bing.connected &&
    gsc &&
    gsc.overallTotals.impressions >= BING_GAP_MIN_GOOGLE_IMPRESSIONS &&
    bing.impressions === 0
  ) {
    actions.push({
      id: "bing_missing",
      priority: "later",
      title: "The page is invisible on Bing",
      why: `Google showed this page ${fmt(gsc.overallTotals.impressions)} times, but Bing reports zero impressions — you're missing Bing's audience (and the AI assistants that use Bing's index).`,
      steps: [
        "Submit the URL in Bing Webmaster Tools (URL Submission).",
        "Confirm the page is in the sitemap Bing reads.",
        "Check Bing Webmaster Tools for crawl errors on this URL.",
      ],
      link: "/bing",
      linkLabel: "Open the Bing report",
    });
  }

  return actions.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}
