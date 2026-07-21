import { Router, type IRouter } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { db, sitesTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { ClaimLegacySiteBody } from "@workspace/api-zod";
import { requireAuth, type AuthedRequest } from "../lib/auth";
import { invalidateSiteCache } from "../lib/site";

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
// Legacy-site claim: one-time ownership transfer gated on the previous
// shared admin password. Timing-safe compare + per-user/IP rate limit so the
// endpoint cannot be used to brute-force the password.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
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

    if (rateLimited(`${userId}|${req.ip ?? "?"}`)) {
      res.status(429).json({ error: "Too many attempts — try again later" });
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
      res.status(409).json({ error: "Legacy site is already claimed" });
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
      res.status(409).json({ error: "Legacy site is already claimed" });
      return;
    }

    invalidateSiteCache(LEGACY_SITE_ID);
    req.log.info({ userId }, "legacy site claimed");
    res.json(toSiteDto(updated[0]));
  } catch (err) {
    next(err);
  }
});

export default router;
