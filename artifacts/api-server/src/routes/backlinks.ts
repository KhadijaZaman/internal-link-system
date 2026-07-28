import { Router, type IRouter } from "express";
import { db, backlinkProspectsTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  DiscoverBacklinkProspectsBody,
  UpdateBacklinkProspectBody,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { withCache } from "../integrations/gsc";
import { fetchTopReferringDomains, type ReferringDomain } from "../integrations/dataforseo";

const router: IRouter = Router();

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PER_TARGET_LIMIT = 100;

function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

function serialize(row: typeof backlinkProspectsTable.$inferSelect) {
  return {
    id: row.id,
    domain: row.domain,
    rank: row.rank,
    backlinks: row.backlinks,
    competitorsLinking: (row.competitorsLinking as string[] | null) ?? [],
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listProspects(siteId: number) {
  const rows = await db
    .select()
    .from(backlinkProspectsTable)
    .where(eq(backlinkProspectsTable.siteId, siteId))
    .orderBy(
      sql`jsonb_array_length(${backlinkProspectsTable.competitorsLinking}) desc`,
      desc(backlinkProspectsTable.rank),
    );
  return { prospects: rows.map(serialize) };
}

router.get("/backlinks/prospects", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    res.json(await listProspects(site.id));
  } catch (err) {
    next(err);
  }
});

router.post("/backlinks/prospects", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = DiscoverBacklinkProspectsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const competitors = [
      ...new Set(
        parsed.data.competitors
          .map(normalizeDomain)
          .filter((d): d is string => d !== null),
      ),
    ];
    const ownHost = site.host.replace(/^www\./, "").toLowerCase();
    const targets = competitors.filter((c) => c !== ownHost);
    if (targets.length === 0) {
      res.status(400).json({ error: "Enter at least one valid competitor domain (not your own site)" });
      return;
    }

    // One cached pull per target + one for our own site (to exclude domains
    // that already link to us). DataForSEO referring-domain reads, 6h cache.
    const fetchCached = (target: string): Promise<ReferringDomain[]> =>
      withCache(`s${site.id}|backlinks|${target}`, CACHE_TTL_MS, () =>
        fetchTopReferringDomains(target, PER_TARGET_LIMIT),
      );
    const [ownRefs, ...competitorRefs] = await Promise.all([
      fetchCached(ownHost).catch(() => [] as ReferringDomain[]),
      ...targets.map((t) => fetchCached(t).catch(() => [] as ReferringDomain[])),
    ]);
    const linksToUs = new Set(ownRefs.map((r) => r.domain.replace(/^www\./, "")));

    // Aggregate: domain -> which competitors it links to, best rank, total backlinks.
    const agg = new Map<string, { rank: number | null; backlinks: number; competitors: Set<string> }>();
    targets.forEach((target, i) => {
      for (const r of competitorRefs[i] ?? []) {
        const d = r.domain.replace(/^www\./, "").toLowerCase();
        if (!d || d === ownHost || d === target || linksToUs.has(d)) continue;
        const cur = agg.get(d) ?? { rank: null, backlinks: 0, competitors: new Set<string>() };
        cur.rank = cur.rank === null ? r.rank : Math.max(cur.rank, r.rank ?? 0);
        cur.backlinks += r.backlinks;
        cur.competitors.add(target);
        agg.set(d, cur);
      }
    });

    // Upsert prospects; never downgrade an existing outreach status.
    const now = new Date();
    for (const [domain, info] of agg) {
      await db
        .insert(backlinkProspectsTable)
        .values({
          siteId: site.id,
          domain,
          rank: info.rank,
          backlinks: info.backlinks,
          competitorsLinking: [...info.competitors].sort(),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [backlinkProspectsTable.siteId, backlinkProspectsTable.domain],
          set: {
            rank: info.rank,
            backlinks: info.backlinks,
            competitorsLinking: sql`(
              select to_jsonb(array(select distinct e from jsonb_array_elements_text(
                ${backlinkProspectsTable.competitorsLinking} || ${JSON.stringify([...info.competitors])}::jsonb
              ) as e order by e))
            )`,
            updatedAt: now,
          },
        });
    }
    req.log.info(
      { siteId: site.id, targets, discovered: agg.size },
      "Backlink prospect discovery complete",
    );
    res.json(await listProspects(site.id));
  } catch (err) {
    next(err);
  }
});

router.patch("/backlinks/prospects/:prospectId", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const id = Number(req.params["prospectId"]);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }
    const parsed = UpdateBacklinkProspectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const set: Partial<typeof backlinkProspectsTable.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.status !== undefined) set.status = parsed.data.status;
    if (parsed.data.notes !== undefined) set.notes = parsed.data.notes;
    const [row] = await db
      .update(backlinkProspectsTable)
      .set(set)
      .where(
        and(eq(backlinkProspectsTable.id, id), eq(backlinkProspectsTable.siteId, site.id)),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});

export default router;
