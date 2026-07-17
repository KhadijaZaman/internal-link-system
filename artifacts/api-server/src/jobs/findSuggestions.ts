import {
  db,
  inventoryTable,
  linkStatsTable,
  linkGraphTable,
  linkSuggestionsTable,
  linkExcludeListTable,
} from "@workspace/db";
import { sectionFor, isHomepage } from "../lib/sections";
import { generateSuggestion } from "../integrations/claude";
import { logger } from "../lib/logger";
import * as cheerio from "cheerio";

const SECTION_WEIGHTS: Record<string, number> = {
  outer_to_core: 1.5,
  core_to_core: 1.2,
  outer_to_outer: 0.8,
  core_to_outer: 0.4,
};

const RATIONALES: Record<string, string> = {
  outer_to_core:
    "Outer->Core: educational page links up to commercial cluster. Outer builds historical data, core drives monetization.",
  core_to_core:
    "Core->Core: sibling cluster reinforcement around central entity (AI visibility).",
  outer_to_outer: "Outer->Outer: contextual bridge inside know-predicate territory.",
  core_to_outer: "Core->Outer: donates authority outward. Use sparingly per Koray Lecture #80.",
};

interface PageInfo {
  url: string;
  title: string | null;
  h1: string | null;
  section: "core" | "outer";
  topQuery: string | null;
  position: number | null;
  impressions: number | null;
  clicks: number | null;
  inboundCount: number;
  outboundCount: number;
  pagerank: number;
}

function compilePattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

function isExcluded(url: string, regexes: RegExp[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return regexes.some((re) => re.test(path) || re.test(url));
}

export async function runFindSuggestions(): Promise<void> {
  const inv = await db.select().from(inventoryTable);
  const stats = await db.select().from(linkStatsTable);
  const graph = await db.select().from(linkGraphTable);
  const excludes = await db.select().from(linkExcludeListTable);
  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));

  const statsMap = new Map(stats.map((s) => [s.url, s]));
  const titleMap = new Map<string, { title?: string | null; h1?: string | null }>();
  for (const e of graph) {
    if (!titleMap.has(e.sourceUrl)) titleMap.set(e.sourceUrl, {});
  }

  const pages = new Map<string, PageInfo>();
  for (const i of inv) {
    const s = statsMap.get(i.url);
    pages.set(i.url, {
      url: i.url,
      title: i.title,
      h1: i.h1,
      section: sectionFor(i.url),
      topQuery: i.topQuery,
      position: i.position,
      impressions: i.impressions,
      clicks: i.clicks,
      inboundCount: s?.inboundCount ?? 0,
      outboundCount: s?.outboundCount ?? 0,
      pagerank: s?.internalPagerank ?? 0,
    });
  }
  for (const s of stats) {
    if (!pages.has(s.url)) {
      pages.set(s.url, {
        url: s.url,
        title: null,
        h1: null,
        section: sectionFor(s.url),
        topQuery: null,
        position: null,
        impressions: null,
        clicks: null,
        inboundCount: s.inboundCount,
        outboundCount: s.outboundCount,
        pagerank: s.internalPagerank,
      });
    }
  }

  const existing = new Set<string>();
  // Content (body) edges only — see semanticLinking.ts for the same rule.
  // Nav/header/footer links don't satisfy the editorial need for an
  // in-context link, so they shouldn't suppress a suggestion.
  for (const e of graph) {
    if (e.placement !== "content") continue;
    existing.add(`${e.sourceUrl}||${e.targetUrl}`);
  }

  const receivers = [...pages.values()].filter(
    (p) =>
      p.position !== null &&
      p.position >= 4 &&
      p.position <= 20 &&
      (p.impressions ?? 0) >= 30 &&
      !isExcluded(p.url, excludeRegexes),
  );
  const donors = [...pages.values()].filter(
    (p) =>
      !isExcluded(p.url, excludeRegexes) &&
      ((p.position !== null && p.position < 4 && (p.clicks ?? 0) > 5) ||
        (p.pagerank > 0 && p.inboundCount >= 2)),
  );
  logger.info(
    { receivers: receivers.length, donors: donors.length, excludes: excludeRegexes.length },
    "Suggestions: candidates",
  );

  interface Candidate {
    donor: PageInfo;
    receiver: PageInfo;
    anchorText: string;
    sectionLinkType: string;
    overlap: number;
    priority: number;
  }
  const candidates: Candidate[] = [];
  for (const r of receivers) {
    const anchor = (r.h1 ?? r.title ?? r.topQuery ?? "").trim();
    if (anchor.length < 5) continue;
    const queryWords = (r.topQuery ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    for (const d of donors) {
      if (d.url === r.url) continue;
      if (existing.has(`${d.url}||${r.url}`)) continue;
      // Homepage donor restriction: don't suggest homepage → non-core (blog) links.
      if (isHomepage(d.url) && r.section !== "core") continue;
      const linkType = `${d.section}_to_${r.section}`;
      const weight = SECTION_WEIGHTS[linkType] ?? 1;
      const donorText = `${d.h1 ?? ""} ${d.title ?? ""} ${d.topQuery ?? ""}`.toLowerCase();
      let overlap = 0;
      if (queryWords.length > 0) {
        const matches = queryWords.filter((w) => donorText.includes(w)).length;
        overlap = matches / queryWords.length;
      }
      if (overlap < 0.3) continue;
      const score = ((r.impressions ?? 0) / (r.position ?? 1)) * weight * overlap;
      candidates.push({
        donor: d,
        receiver: r,
        anchorText: anchor,
        sectionLinkType: linkType,
        overlap,
        priority: score,
      });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const top = candidates.slice(0, 100);
  logger.info({ top: top.length }, "Suggestions: top candidates");

  // Process with concurrency limit
  const SEM = 5;
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= top.length) return;
      const c = top[myIdx]!;
      try {
        const donorRes = await fetch(c.donor.url, {
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);
        if (!donorRes || !donorRes.ok) continue;
        const html = await donorRes.text();
        const $ = cheerio.load(html);
        const body = $("body").text().replace(/\s+/g, " ").trim();
        const result = await generateSuggestion({
          donorBody: body,
          receiverUrl: c.receiver.url,
          receiverH1: c.receiver.h1 ?? c.anchorText,
          anchorText: c.anchorText,
        });
        if (!result) continue;
        await db
          .insert(linkSuggestionsTable)
          .values({
            donorUrl: c.donor.url,
            receiverUrl: c.receiver.url,
            anchorText: c.anchorText,
            korayRationale: `${RATIONALES[c.sectionLinkType] ?? ""} ${result.whyThisFits}`.trim(),
            sectionLinkType: c.sectionLinkType,
            insertionSentence: result.insertionParagraph,
            priorityScore: c.priority,
            status: "pending_review",
          })
          .onConflictDoNothing();
      } catch (e) {
        logger.warn({ err: e }, "Suggestion processing failed");
      }
    }
  }
  await Promise.all(Array.from({ length: SEM }, () => worker()));
  logger.info("Suggestions: done");
}
