import { Router, type IRouter } from "express";
import { db, backlinkProspectsTable, backlinkAuditsTable, backlinkHistoryTable } from "@workspace/db";
import { and, eq, desc, asc, sql, inArray } from "drizzle-orm";
import {
  DiscoverBacklinkProspectsBody,
  RunBacklinkAuditBody,
  UpdateBacklinkProspectBody,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { withCache } from "../integrations/gsc";
import {
  fetchTopReferringDomains,
  fetchBacklinkSummary,
  fetchBacklinkAnchors,
  fetchTopBacklinks,
  isDataForSeoOutOfFunds,
  type ReferringDomain,
  type BacklinkSummary,
} from "../integrations/dataforseo";

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

// ---------- Backlink audit (comprehensive profile, persisted) ----------

/** Audit pulls are paid; refresh at most once a day unless data is missing. */
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;

async function loadAudit(siteId: number) {
  const rows = await db
    .select()
    .from(backlinkAuditsTable)
    .where(eq(backlinkAuditsTable.siteId, siteId));
  if (rows.length === 0) return null;
  const own = rows.find((r) => r.kind === "own_profile");
  if (!own) return null;
  const competitorRows = rows.filter((r) => r.kind === "competitor_summary");
  const payload = own.payload as {
    summary: BacklinkSummary | null;
    anchors: unknown[];
    topBacklinks: unknown[];
    referringDomains: unknown[];
  };
  return {
    fetchedAt: own.fetchedAt.toISOString(),
    target: own.target,
    summary: payload.summary,
    anchors: payload.anchors,
    topBacklinks: payload.topBacklinks,
    referringDomains: payload.referringDomains,
    competitors: competitorRows
      .map((r) => ({ ...(r.payload as BacklinkSummary), target: r.target }))
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)),
  };
}

router.get("/backlinks/audit", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const audit = await loadAudit(site.id);
    res.json({ audit });
  } catch (err) {
    next(err);
  }
});

router.post("/backlinks/audit", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = RunBacklinkAuditBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const ownHost = site.host.replace(/^www\./, "").toLowerCase();
    const competitors = [
      ...new Set(
        (parsed.data.competitors ?? [])
          .map(normalizeDomain)
          .filter((d): d is string => d !== null && d !== ownHost),
      ),
    ].slice(0, 5);

    const refresh = !!parsed.data.refresh;
    const staleBefore = Date.now() - AUDIT_TTL_MS;

    // Current persisted state, per row so freshness is per component.
    const rows = await db
      .select({
        target: backlinkAuditsTable.target,
        kind: backlinkAuditsTable.kind,
        fetchedAt: backlinkAuditsTable.fetchedAt,
      })
      .from(backlinkAuditsTable)
      .where(eq(backlinkAuditsTable.siteId, site.id));
    const ownRow = rows.find((r) => r.kind === "own_profile");
    const compFetchedAt = new Map(
      rows.filter((r) => r.kind === "competitor_summary").map((r) => [r.target, r.fetchedAt.getTime()]),
    );

    // If competitors were provided, they define the benchmark set: drop rows
    // outside it. If omitted, keep the existing benchmark set as-is.
    const benchmarkSet = competitors.length > 0 ? competitors : [...compFetchedAt.keys()];
    const obsolete = [...compFetchedAt.keys()].filter((t) => !benchmarkSet.includes(t));
    if (obsolete.length > 0) {
      await db
        .delete(backlinkAuditsTable)
        .where(
          and(
            eq(backlinkAuditsTable.siteId, site.id),
            eq(backlinkAuditsTable.kind, "competitor_summary"),
            inArray(backlinkAuditsTable.target, obsolete),
          ),
        );
    }

    const needOwn = refresh || !ownRow || ownRow.fetchedAt.getTime() < staleBefore;
    const compTargets = benchmarkSet.filter((c) => {
      const at = compFetchedAt.get(c);
      return refresh || at === undefined || at < staleBefore;
    });

    if (!needOwn && compTargets.length === 0) {
      res.json({ audit: await loadAudit(site.id) });
      return;
    }

    // All-or-nothing per unit: the own profile persists only if all four legs
    // succeed; each competitor summary persists independently. A 402 anywhere
    // surfaces as 402 — a 200 never hides a failed leg.
    try {
      const now = new Date();
      if (needOwn) {
        const settled = await Promise.allSettled([
          fetchBacklinkSummary(ownHost),
          fetchBacklinkAnchors(ownHost, 30),
          fetchTopBacklinks(ownHost, 50),
          fetchTopReferringDomains(ownHost, 100),
        ]);
        const failed = settled.filter((s) => s.status === "rejected");
        if (failed.length > 0) {
          const outOfFunds = failed.find((f) => isDataForSeoOutOfFunds(f.reason));
          throw outOfFunds ? outOfFunds.reason : (failed[0] as PromiseRejectedResult).reason;
        }
        const [summary, anchors, topBacklinks, referringDomains] = settled.map(
          (s) => (s as PromiseFulfilledResult<unknown>).value,
        );
        await db
          .insert(backlinkAuditsTable)
          .values({
            siteId: site.id,
            target: ownHost,
            kind: "own_profile",
            payload: { summary, anchors, topBacklinks, referringDomains },
            fetchedAt: now,
          })
          .onConflictDoUpdate({
            target: [backlinkAuditsTable.siteId, backlinkAuditsTable.target, backlinkAuditsTable.kind],
            set: {
              payload: { summary, anchors, topBacklinks, referringDomains },
              fetchedAt: now,
            },
          });
      }
      for (const target of compTargets) {
        const s = await fetchBacklinkSummary(target);
        if (!s) continue;
        await db
          .insert(backlinkAuditsTable)
          .values({ siteId: site.id, target, kind: "competitor_summary", payload: s, fetchedAt: now })
          .onConflictDoUpdate({
            target: [backlinkAuditsTable.siteId, backlinkAuditsTable.target, backlinkAuditsTable.kind],
            set: { payload: s, fetchedAt: now },
          });
      }
      // Append a history snapshot for today (UTC). One upsert per calendar day.
      if (needOwn) {
        const ownProfileRow = await db
          .select({ payload: backlinkAuditsTable.payload })
          .from(backlinkAuditsTable)
          .where(and(eq(backlinkAuditsTable.siteId, site.id), eq(backlinkAuditsTable.kind, "own_profile")))
          .limit(1);
        if (ownProfileRow.length > 0) {
          const p = ownProfileRow[0]!.payload as { summary?: BacklinkSummary | null };
          const s = p.summary;
          const todayUtc = new Date().toISOString().slice(0, 10);
          await db
            .insert(backlinkHistoryTable)
            .values({
              siteId: site.id,
              date: todayUtc,
              rank: s?.rank ?? null,
              backlinks: s?.backlinks ?? null,
              referringDomains: s?.referringDomains ?? null,
              dofollow: s?.dofollow ?? null,
            })
            .onConflictDoUpdate({
              target: [backlinkHistoryTable.siteId, backlinkHistoryTable.date],
              set: {
                rank: s?.rank ?? null,
                backlinks: s?.backlinks ?? null,
                referringDomains: s?.referringDomains ?? null,
                dofollow: s?.dofollow ?? null,
                recordedAt: now,
              },
            });
        }
      }
      req.log.info(
        { siteId: site.id, ownRefreshed: needOwn, competitorsFetched: compTargets, removed: obsolete },
        "Backlink audit complete",
      );
    } catch (err) {
      if (isDataForSeoOutOfFunds(err)) {
        res.status(402).json({
          error:
            "DataForSEO is out of funds. Top up your balance at app.dataforseo.com, then run the audit again.",
        });
        return;
      }
      throw err;
    }
    res.json({ audit: await loadAudit(site.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/backlinks/history", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const rows = await db
      .select({
        date: backlinkHistoryTable.date,
        rank: backlinkHistoryTable.rank,
        backlinks: backlinkHistoryTable.backlinks,
        referringDomains: backlinkHistoryTable.referringDomains,
        dofollow: backlinkHistoryTable.dofollow,
      })
      .from(backlinkHistoryTable)
      .where(eq(backlinkHistoryTable.siteId, site.id))
      .orderBy(asc(backlinkHistoryTable.date));
    res.json({ history: rows });
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
