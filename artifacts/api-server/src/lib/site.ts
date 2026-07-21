import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";

/**
 * Site scoping middleware. Site-scoped routes mount `requireSite` AFTER
 * `requireAuth`; it reads the numeric site id from the `X-Site-Id` header,
 * verifies the signed-in user owns that site, and exposes the site row as
 * `req.site` (read via `getSite` / `getSiteId`).
 *
 * Site lookups are cached in-memory for a short TTL to avoid a DB
 * round-trip on every request; the cache is invalidated when ownership
 * changes (site claim).
 */

export interface SiteContext {
  id: number;
  ownerUserId: string | null;
  domain: string;
  host: string;
  displayName: string;
  sitemapUrl: string | null;
}

export interface SiteScopedRequest extends AuthedRequest {
  site?: SiteContext;
}

export const LEGACY_SITE_ID = 1;

const SITE_CACHE_TTL_MS = 30_000;
const siteCache = new Map<number, { site: SiteContext; expiresAt: number }>();

export function invalidateSiteCache(siteId: number): void {
  siteCache.delete(siteId);
}

async function fetchSite(siteId: number): Promise<SiteContext | undefined> {
  const cached = siteCache.get(siteId);
  if (cached && cached.expiresAt > Date.now()) return cached.site;

  const { db, sitesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: sitesTable.id,
      ownerUserId: sitesTable.ownerUserId,
      domain: sitesTable.domain,
      host: sitesTable.host,
      displayName: sitesTable.displayName,
      sitemapUrl: sitesTable.sitemapUrl,
    })
    .from(sitesTable)
    .where(eq(sitesTable.id, siteId))
    .limit(1);

  // undefined = site does not exist (not cached — cheap and rare).
  if (rows.length === 0) return undefined;

  const site = rows[0];
  siteCache.set(siteId, { site, expiresAt: Date.now() + SITE_CACHE_TTL_MS });
  return site;
}

/** Read the validated site set by `requireSite`. */
export function getSite(req: Request): SiteContext {
  const site = (req as SiteScopedRequest).site;
  if (!site) {
    throw new Error("getSite() called on a route without requireSite");
  }
  return site;
}

/** Read the validated site id set by `requireSite`. */
export function getSiteId(req: Request): number {
  return getSite(req).id;
}

export function requireSite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = req.header("x-site-id");
  const siteId = raw ? Number(raw) : NaN;
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ error: "Missing or invalid X-Site-Id header" });
    return;
  }

  fetchSite(siteId)
    .then((site) => {
      if (site === undefined) {
        res.status(404).json({ error: "Site not found" });
        return;
      }
      if (site.ownerUserId === null || site.ownerUserId !== userId) {
        res.status(403).json({ error: "You do not have access to this site" });
        return;
      }
      (req as SiteScopedRequest).site = site;
      next();
    })
    .catch((err) => next(err));
}

/**
 * The migrated legacy site (id 1). Background jobs are legacy-only until
 * per-site job scheduling lands (task #20); they resolve this once at start
 * and thread it through explicitly.
 */
export async function getLegacySite(): Promise<SiteContext> {
  const site = await fetchSite(LEGACY_SITE_ID);
  if (!site) {
    throw new Error("Legacy site (id 1) not found — migration has not run");
  }
  return site;
}
