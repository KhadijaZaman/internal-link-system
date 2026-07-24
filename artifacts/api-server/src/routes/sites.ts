import { Router, type IRouter } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { db, sitesTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  ClaimLegacySiteBody,
  CreateSiteBody,
  UpdateSiteBody,
  UpdateSiteLimitsBody,
} from "@workspace/api-zod";
import { requireAuth, type AuthedRequest } from "../lib/auth";
import { bumpAndCheck, cleanupExpiredClaimAttempts } from "../lib/claimRateLimit";
import { deleteSiteData } from "../lib/deleteSiteData";
import { hasRunningJobs } from "../jobs/runner";
import { getSite, invalidateSiteCache, requireSite } from "../lib/site";
import { normalizeHost } from "../lib/urlCanon";

const router: IRouter = Router();

const LEGACY_SITE_ID = 1;

function toSiteDto(row: {
  id: number;
  domain: string;
  host: string;
  displayName: string;
  sitemapUrl: string | null;
}) {
  return {
    id: row.id,
    domain: row.domain,
    host: row.host,
    displayName: row.displayName,
    sitemapUrl: row.sitemapUrl,
  };
}

router.get("/sites", requireAuth, async (req, res, next) => {
  try {
    const userId = (req as AuthedRequest).userId!;
    const [owned, legacy] = await Promise.all([
      db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.ownerUserId, userId))
        .orderBy(asc(sitesTable.id)),
      db
        .select({ ownerUserId: sitesTable.ownerUserId })
        .from(sitesTable)
        .where(eq(sitesTable.id, LEGACY_SITE_ID))
        .limit(1),
    ]);
    res.json({
      sites: owned.map(toSiteDto),
      legacyClaimable: legacy.length > 0 && legacy[0].ownerUserId === null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Create a site owned by the signed-in user. Domain is validated and
// canonicalized to a bare host; hosts are globally unique.
// ---------------------------------------------------------------------------

const MAX_SITES_PER_USER = 10;

router.post("/sites", requireAuth, async (req, res, next) => {
  try {
    const userId = (req as AuthedRequest).userId!;
    const parsed = CreateSiteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { domain, displayName, sitemapUrl } = parsed.data;

    // Accept "example.com" or a full URL; canonicalize to bare host.
    const withScheme = /^https?:\/\//i.test(domain.trim())
      ? domain.trim()
      : `https://${domain.trim()}`;
    let host: string;
    let cleanDomain: string;
    try {
      const u = new URL(withScheme);
      if (!u.hostname || !u.hostname.includes(".")) throw new Error("bad host");
      host = normalizeHost(u.hostname);
      cleanDomain = `${u.protocol}//${u.hostname}`;
    } catch {
      res.status(400).json({ error: "Enter a valid domain, e.g. example.com" });
      return;
    }

    let cleanSitemap: string | null = null;
    if (sitemapUrl && sitemapUrl.trim()) {
      try {
        const su = new URL(sitemapUrl.trim());
        if (su.protocol !== "https:" && su.protocol !== "http:") throw new Error("bad scheme");
        cleanSitemap = su.toString();
      } catch {
        res.status(400).json({ error: "Sitemap must be a valid http(s) URL" });
        return;
      }
    }

    const owned = await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.ownerUserId, userId));
    if (owned.length >= MAX_SITES_PER_USER) {
      res.status(409).json({ error: "Site limit reached" });
      return;
    }

    const existing = await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.host, host))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "A site with this domain already exists" });
      return;
    }

    const name = displayName?.trim() || host;
    const inserted = await db
      .insert(sitesTable)
      .values({
        ownerUserId: userId,
        domain: cleanDomain,
        host,
        displayName: name.slice(0, 120),
        sitemapUrl: cleanSitemap,
      })
      .returning();

    req.log.info({ userId, host, siteId: inserted[0].id }, "site created");
    res.status(201).json(toSiteDto(inserted[0]));
  } catch (err) {
    // Unique-index race: two concurrent creates with the same host.
    if (err instanceof Error && /sites_host_uniq/.test(err.message)) {
      res.status(409).json({ error: "A site with this domain already exists" });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Legacy-site claim: one-time ownership transfer gated on the previous
// shared admin password. Timing-safe compare + per-user/IP rate limit so the
// endpoint cannot be used to brute-force the password.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5; // per user|ip
const MAX_ATTEMPTS_PER_IP = 10; // across all accounts from one IP
const MAX_ATTEMPTS_GLOBAL = 30; // endpoint-wide, all users and IPs combined

// Once claimed, the endpoint is permanently disabled (410). In-memory flag is
// a fast-path; the DB ownership check below remains authoritative across
// restarts and multiple instances.
let legacyClaimed = false;

// Sign-up is open, so an attacker can mint accounts to multiply the per-user
// budget. Layered budgets: per user|ip, per ip (all accounts), and a global
// endpoint-wide cap. All three counters are bumped on every attempt.
// Returns null when not limited, otherwise the number of seconds until the
// longest active lockout among the tripped counters expires.
async function rateLimited(userId: string, ip: string): Promise<number | null> {
  // Opportunistic cleanup of long-expired counter rows (fire-and-forget).
  // Rows are kept for the maximum lockout after expiry so accumulated
  // strikes (escalating-backoff history) only decay after a long quiet gap.
  cleanupExpiredClaimAttempts().catch(() => {});
  const results = await Promise.all([
    bumpAndCheck(`u|${userId}|${ip}`, MAX_ATTEMPTS),
    bumpAndCheck(`ip|${ip}`, MAX_ATTEMPTS_PER_IP),
    bumpAndCheck("global", MAX_ATTEMPTS_GLOBAL),
  ]);
  const tripped = results.filter((r) => r.limited);
  if (tripped.length === 0) return null;
  const latest = Math.max(...tripped.map((r) => r.resetAt.getTime()));
  return Math.max(1, Math.ceil((latest - Date.now()) / 1000));
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hours`;
}

function passwordMatches(candidate: string): boolean {
  const expected = process.env["ADMIN_PASSWORD"];
  if (!expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

router.post("/sites/claim-legacy", requireAuth, async (req, res, next) => {
  try {
    const userId = (req as AuthedRequest).userId!;
    const parsed = ClaimLegacySiteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    if (legacyClaimed) {
      res.status(410).json({ error: "Legacy site claim is closed" });
      return;
    }

    const retryAfterSeconds = await rateLimited(userId, req.ip ?? "?");
    if (retryAfterSeconds !== null) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: `Too many attempts — try again in ${formatWait(retryAfterSeconds)}`,
        retryAfterSeconds,
      });
      return;
    }

    const legacy = await db
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, LEGACY_SITE_ID))
      .limit(1);
    if (legacy.length === 0) {
      res.status(409).json({ error: "No legacy site to claim" });
      return;
    }
    if (legacy[0].ownerUserId !== null) {
      legacyClaimed = true;
      res.status(410).json({ error: "Legacy site claim is closed" });
      return;
    }

    if (!passwordMatches(parsed.data.password)) {
      req.log.warn({ userId }, "legacy site claim: wrong password");
      res.status(403).json({ error: "Wrong password" });
      return;
    }

    // Guard against a concurrent claim: only flip ownership if still null.
    const { and, isNull } = await import("drizzle-orm");
    const updated = await db
      .update(sitesTable)
      .set({ ownerUserId: userId })
      .where(
        and(eq(sitesTable.id, LEGACY_SITE_ID), isNull(sitesTable.ownerUserId)),
      )
      .returning();
    if (updated.length === 0) {
      legacyClaimed = true;
      res.status(410).json({ error: "Legacy site claim is closed" });
      return;
    }

    legacyClaimed = true;
    invalidateSiteCache(LEGACY_SITE_ID);
    req.log.info({ userId }, "legacy site claimed");

    // The legacy-site claimant is the platform operator: promote to admin
    // immediately (same guard as the startup bootstrap — only if no admin
    // exists yet). Fail-soft: the claim itself already succeeded.
    try {
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        UPDATE users SET is_admin = true
        WHERE id = ${userId}
          AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true)
      `);
    } catch (err) {
      req.log.warn({ err }, "admin promotion after legacy claim failed (startup bootstrap will retry)");
    }

    res.json(toSiteDto(updated[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Per-site job spend limits. Bounds mirror the OpenAPI contract; the Zod body
// schema (generated from the spec) enforces them on PATCH, and GET returns
// them so the UI can render validation without hardcoding.
// ---------------------------------------------------------------------------

const LIMIT_BOUNDS = {
  maxCrawlPages: { min: 50, max: 20000, default: 2000 },
  maxLlmCallsPerRun: { min: 10, max: 5000, default: 500 },
  maxSerpQueriesPerRun: { min: 5, max: 2000, default: 100 },
} as const;

function toLimitsResponse(site: {
  maxCrawlPages: number;
  maxLlmCallsPerRun: number;
  maxSerpQueriesPerRun: number;
}) {
  return {
    limits: {
      maxCrawlPages: site.maxCrawlPages,
      maxLlmCallsPerRun: site.maxLlmCallsPerRun,
      maxSerpQueriesPerRun: site.maxSerpQueriesPerRun,
    },
    bounds: LIMIT_BOUNDS,
  };
}

router.get("/site/limits", requireAuth, requireSite, (req, res) => {
  res.json(toLimitsResponse(getSite(req)));
});

router.patch("/site/limits", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = UpdateSiteLimitsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A limit is outside the allowed bounds" });
      return;
    }
    const patch: Partial<{
      maxCrawlPages: number;
      maxLlmCallsPerRun: number;
      maxSerpQueriesPerRun: number;
    }> = {};
    const { maxCrawlPages, maxLlmCallsPerRun, maxSerpQueriesPerRun } = parsed.data;
    if (maxCrawlPages !== undefined && Number.isInteger(maxCrawlPages)) {
      patch.maxCrawlPages = maxCrawlPages;
    }
    if (maxLlmCallsPerRun !== undefined && Number.isInteger(maxLlmCallsPerRun)) {
      patch.maxLlmCallsPerRun = maxLlmCallsPerRun;
    }
    if (
      maxSerpQueriesPerRun !== undefined &&
      Number.isInteger(maxSerpQueriesPerRun)
    ) {
      patch.maxSerpQueriesPerRun = maxSerpQueriesPerRun;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No valid limits provided" });
      return;
    }

    const updated = await db
      .update(sitesTable)
      .set(patch)
      .where(eq(sitesTable.id, site.id))
      .returning({
        maxCrawlPages: sitesTable.maxCrawlPages,
        maxLlmCallsPerRun: sitesTable.maxLlmCallsPerRun,
        maxSerpQueriesPerRun: sitesTable.maxSerpQueriesPerRun,
      });
    invalidateSiteCache(site.id);
    req.log.info({ siteId: site.id, ...patch }, "site spend limits updated");
    res.json(toLimitsResponse(updated[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Rename / delete the active site. Both are owner-only via requireSite.
// Deleting removes every row the site owns (one transaction) and is refused
// for the legacy site and while a job is running for the site.
// ---------------------------------------------------------------------------

router.patch("/site", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = UpdateSiteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Display name must be 1-120 characters" });
      return;
    }
    const displayName = parsed.data.displayName.trim();
    if (!displayName) {
      res.status(400).json({ error: "Display name must be 1-120 characters" });
      return;
    }
    const updated = await db
      .update(sitesTable)
      .set({ displayName: displayName.slice(0, 120) })
      .where(eq(sitesTable.id, site.id))
      .returning();
    invalidateSiteCache(site.id);
    req.log.info({ siteId: site.id, displayName }, "site renamed");
    res.json(toSiteDto(updated[0]));
  } catch (err) {
    next(err);
  }
});

router.delete("/site", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    if (site.id === LEGACY_SITE_ID) {
      res.status(409).json({
        error:
          "The original Wellows site can't be deleted — it holds the full historical dataset.",
      });
      return;
    }
    if (hasRunningJobs(site.id)) {
      res.status(409).json({
        error: "A job is currently running for this site. Wait for it to finish, then try again.",
      });
      return;
    }
    await deleteSiteData(site.id);
    req.log.info({ siteId: site.id, host: site.host }, "site deleted");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
