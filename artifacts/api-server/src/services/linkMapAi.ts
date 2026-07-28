import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  inventoryTable,
  linkStatsTable,
  linkGraphTable,
  linkMapRunsTable,
  type LinkMapResult,
  type LinkMapProposal,
  type LinkMapFlag,
  type LinkMapDoNotLink,
} from "@workspace/db";
import { anthropic, BRIEF_MODEL } from "../integrations/claude";
import { sectionFor } from "../lib/sections";
import type { SiteContext } from "../lib/site";

export interface GenerateInput {
  centralEntity: string;
  hubUrl: string | null;
  pageUrls: string[];
  maxNewLinksPerPage: number;
}

export interface CoverageRow {
  url: string;
  h1: string | null;
  layer: string;
  inboundSiteWide: number;
  outIntoCluster: number;
  inFromCluster: number;
}

interface ClusterData {
  rows: Array<{
    url: string;
    h1: string | null;
    topQuery: string | null;
    layer: string;
    inboundSiteWide: number;
    outbound: string[]; // in-cluster content-link targets
    anchorsUsed: string[]; // anchors already pointing AT this url (site-wide)
  }>;
}

/**
 * Deterministic cluster coverage from the crawl DB — the AI never computes
 * these numbers, it only receives them as INPUTS.
 */
export async function loadClusterData(siteId: number, pageUrls: string[]): Promise<ClusterData> {
  const urlSet = new Set(pageUrls);
  const [inv, stats, edges, inboundEdges] = await Promise.all([
    db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.siteId, siteId), inArray(inventoryTable.url, pageUrls))),
    db
      .select()
      .from(linkStatsTable)
      .where(and(eq(linkStatsTable.siteId, siteId), inArray(linkStatsTable.url, pageUrls))),
    db
      .select()
      .from(linkGraphTable)
      .where(
        and(
          eq(linkGraphTable.siteId, siteId),
          eq(linkGraphTable.placement, "content"),
          inArray(linkGraphTable.sourceUrl, pageUrls),
        ),
      ),
    db
      .select({ targetUrl: linkGraphTable.targetUrl, anchorText: linkGraphTable.anchorText })
      .from(linkGraphTable)
      .where(
        and(
          eq(linkGraphTable.siteId, siteId),
          eq(linkGraphTable.placement, "content"),
          inArray(linkGraphTable.targetUrl, pageUrls),
        ),
      ),
  ]);
  const invMap = new Map(inv.map((i) => [i.url, i]));
  const statsMap = new Map(stats.map((s) => [s.url, s]));
  const outMap = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!urlSet.has(e.targetUrl) || e.targetUrl === e.sourceUrl) continue;
    if (!outMap.has(e.sourceUrl)) outMap.set(e.sourceUrl, new Set());
    outMap.get(e.sourceUrl)!.add(e.targetUrl);
  }
  const anchorMap = new Map<string, Set<string>>();
  for (const e of inboundEdges) {
    const a = (e.anchorText ?? "").trim();
    if (!a) continue;
    if (!anchorMap.has(e.targetUrl)) anchorMap.set(e.targetUrl, new Set());
    anchorMap.get(e.targetUrl)!.add(a);
  }
  return {
    rows: pageUrls.map((url) => {
      const i = invMap.get(url);
      return {
        url,
        h1: i?.h1 ?? i?.title ?? null,
        topQuery: i?.topQuery ?? null,
        layer: i?.section ?? sectionFor(url),
        inboundSiteWide: statsMap.get(url)?.inboundCount ?? 0,
        outbound: [...(outMap.get(url) ?? [])],
        anchorsUsed: [...(anchorMap.get(url) ?? [])].slice(0, 8),
      };
    }),
  };
}

export function buildCoverage(data: ClusterData): CoverageRow[] {
  const inFrom = new Map<string, number>();
  for (const r of data.rows) for (const t of r.outbound) inFrom.set(t, (inFrom.get(t) ?? 0) + 1);
  return data.rows.map((r) => ({
    url: r.url,
    h1: r.h1,
    layer: r.layer,
    inboundSiteWide: r.inboundSiteWide,
    outIntoCluster: r.outbound.length,
    inFromCluster: inFrom.get(r.url) ?? 0,
  }));
}

const RULES_BLOCK = `Apply these rules in order — earlier rules win when two conflict. Every proposed link must name the rule(s) that justify it; if a link cannot be justified by a rule, do not propose it.

R1 — Hierarchy before affinity. Every page links up to its parent, and the parent links down to every child. Sibling-to-sibling links only where R4 can be satisfied.
R2 — Asymmetry encodes structure. Do not reciprocate every pair. Parent↔child is bidirectional; sibling→sibling is usually one-directional, in the direction the reader's question travels.
R3 — Anchor text lemmatizes to the target's H1. The anchor must be the target's canonical query or a close morphological variant of its H1. Never "click here", "this post", "learn more", or the bare brand name.
R4 — Every link needs a bridge sentence stating the relationship between the two pages. If you cannot write it without padding, the link does not belong.
R5 — Placement follows attention. Main content, early in the body, inside a paragraph that argues for it. Never a "Related posts" block.
R6 — Respect the link budget. On high-authority pages propose few, well-placed links rather than many.
R7 — Relevance gate. Do not link pages whose topics only loosely touch.
R8 — Depth ceiling. Every page should be reachable within 3 clicks of the hub; flag any page that is not.
R9 — Anchor diversity across sources, consistency of meaning. Different surface form per source page, identical meaning; never one anchor for two targets.
R10 — Commercial pages receive, informational pages send.`;

function buildUserPrompt(input: GenerateInput, data: ClusterData): string {
  const table = data.rows
    .map((r) =>
      [
        `URL: ${r.url}`,
        `  H1: ${r.h1 ?? "(unknown)"}`,
        `  Canonical query: ${r.topQuery ?? "(unknown)"}`,
        `  Layer: ${r.layer}${input.hubUrl === r.url ? " (HUB)" : ""}`,
        `  Inbound internal links site-wide: ${r.inboundSiteWide}`,
        `  Existing outbound content links to others in this set: ${r.outbound.length ? r.outbound.join(", ") : "(none)"}`,
        `  Anchor texts already pointing at this page: ${r.anchorsUsed.length ? r.anchorsUsed.map((a) => `"${a}"`).join(", ") : "(none recorded)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `You are building an internal link map for a topical cluster.

### INPUTS (real crawl + Search Console data — do not invent anything beyond it)

Central entity: ${input.centralEntity}
Hub URL: ${input.hubUrl ?? "(no hub page)"}
Max new links to add per page: ${input.maxNewLinksPerPage}

Pages in scope (${data.rows.length}):

${table}

### RULES

${RULES_BLOCK}

### OUTPUT

Return STRICT JSON only — no preamble, no markdown fences:
{
  "proposals": [
    { "from": "<source URL from the set>", "to": "<target URL from the set>", "anchorText": "...", "placement": "<section + before/after what>", "bridgeSentence": "...", "rules": ["R1"], "why": "one sentence" }
  ],
  "flags": [
    { "type": "orphan|hub_hoards|anchor_collision|reciprocal_pair|depth|link_dump|other", "page": "<URL>", "detail": "one sentence" }
  ],
  "doNotLink": [
    { "from": "<URL>", "to": "<URL>", "reason": "why this plausible-looking link fails R7" }
  ]
}

Constraints on your output:
- Sort proposals by expected impact, best first.
- Never propose more than ${input.maxNewLinksPerPage} new links FROM any single page.
- Do not propose a link that already exists in "Existing outbound content links".
- Only use URLs from the set. Do not invent pages, URLs, or metrics.
- If an input you need is missing (e.g. H1 unknown), work with what is present and note it in flags rather than estimating.`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseResult(text: string, urlSet: Set<string>, maxPerPage: number): LinkMapResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model returned no JSON");
  const parsed = JSON.parse(m[0]) as {
    proposals?: unknown[];
    flags?: unknown[];
    doNotLink?: unknown[];
  };
  const fromCounts = new Map<string, number>();
  const existingPairGuard = new Set<string>();
  const proposals: LinkMapProposal[] = [];
  for (const raw of Array.isArray(parsed.proposals) ? parsed.proposals : []) {
    const p = raw as Record<string, unknown>;
    const from = asString(p["from"]);
    const to = asString(p["to"]);
    // Hard guardrail: the model may only link pages that were in scope.
    if (!urlSet.has(from) || !urlSet.has(to) || from === to) continue;
    const pairKey = `${from}→${to}`;
    if (existingPairGuard.has(pairKey)) continue;
    const count = fromCounts.get(from) ?? 0;
    if (count >= maxPerPage) continue;
    existingPairGuard.add(pairKey);
    fromCounts.set(from, count + 1);
    proposals.push({
      from,
      to,
      anchorText: asString(p["anchorText"]),
      placement: asString(p["placement"]),
      bridgeSentence: asString(p["bridgeSentence"]),
      rules: Array.isArray(p["rules"]) ? p["rules"].filter((r): r is string => typeof r === "string") : [],
      why: asString(p["why"]),
    });
  }
  const flags: LinkMapFlag[] = (Array.isArray(parsed.flags) ? parsed.flags : [])
    .map((raw) => raw as Record<string, unknown>)
    .filter((f) => urlSet.has(asString(f["page"])))
    .map((f) => ({ type: asString(f["type"]) || "other", page: asString(f["page"]), detail: asString(f["detail"]) }));
  const doNotLink: LinkMapDoNotLink[] = (Array.isArray(parsed.doNotLink) ? parsed.doNotLink : [])
    .map((raw) => raw as Record<string, unknown>)
    .filter((d) => urlSet.has(asString(d["from"])) && urlSet.has(asString(d["to"])))
    .map((d) => ({ from: asString(d["from"]), to: asString(d["to"]), reason: asString(d["reason"]) }));
  return { proposals, flags, doNotLink };
}

/**
 * Create the run row and kick off generation in the background. Returns the
 * run id immediately; the dashboard polls /link-map/generations/latest.
 */
export async function startLinkMapGeneration(site: SiteContext, input: GenerateInput): Promise<number> {
  const [run] = await db
    .insert(linkMapRunsTable)
    .values({
      siteId: site.id,
      status: "running",
      centralEntity: input.centralEntity,
      hubUrl: input.hubUrl,
      maxNewLinksPerPage: input.maxNewLinksPerPage,
      pageUrls: input.pageUrls,
      model: BRIEF_MODEL,
    })
    .returning({ id: linkMapRunsTable.id });
  if (!run) throw new Error("Failed to create run");

  void (async () => {
    try {
      const data = await loadClusterData(site.id, input.pageUrls);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let text = "";
      try {
        const msg = await anthropic.messages.create(
          {
            model: BRIEF_MODEL,
            max_tokens: 8000,
            messages: [{ role: "user", content: buildUserPrompt(input, data) }],
          },
          { signal: controller.signal },
        );
        const block = msg.content.find((b) => b.type === "text");
        text = block && block.type === "text" ? block.text : "";
      } finally {
        clearTimeout(timer);
      }
      if (!text) throw new Error("Model returned an empty response");
      const result = parseResult(text, new Set(input.pageUrls), input.maxNewLinksPerPage);
      await db
        .update(linkMapRunsTable)
        .set({ status: "complete", result, finishedAt: new Date() })
        .where(eq(linkMapRunsTable.id, run.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed";
      await db
        .update(linkMapRunsTable)
        .set({ status: "error", error: message, finishedAt: new Date() })
        .where(eq(linkMapRunsTable.id, run.id))
        .catch(() => {});
    }
  })();

  return run.id;
}
