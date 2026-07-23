import { Router, type IRouter } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { db, sitesTable, claimAttemptsTable } from "@workspace/db";
import { asc, eq, lt, sql } from "drizzle-orm";
import { ClaimLegacySiteBody, CreateSiteBody } from "@workspace/api-zod";
import { requireAuth, type AuthedRequest } from "../lib/auth";
import { invalidateSiteCache } from "../lib/site";
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
const WINDOW_MS = 15 * 60 * 1000;

// Once claimed, the endpoint is permanently disabled (410). In-memory flag is
// a fast-path; the DB ownership check below remains authoritative across
// restarts and multiple instances.
let legacyClaimed = false;

// Atomically bump a counter row in Postgres and return whether it exceeded
// its budget. The counters live in the claim_attempts table so restarts and
// Autoscale instance recycling never reset the budget. When the fixed window
// has elapsed the counter resets to 1 and a fresh window begins.
async function bumpAndCheck(key: string, max: number): Promise<boolean> {
  const rows = await db
    .insert(claimAttemptsTable)
    .values({ key, count: 1, resetAt: sql`now() + make_interval(secs => ${WINDOW_MS / 1000})` })
    .onConflictDoUpdate({
      target: claimAttemptsTable.key,
      set: {
        count: sql`CASE WHEN ${claimAttemptsTable.resetAt} <= now() THEN 1 ELSE ${claimAttemptsTable.count} + 1 END`,
        resetAt: sql`CASE WHEN ${claimAttemptsTable.resetAt} <= now() THEN now() + make_interval(secs => ${WINDOW_MS / 1000}) ELSE ${claimAttemptsTable.resetAt} END`,
      },
    })
    .returning({ count: claimAttemptsTable.count });
  return rows[0].count > max;
}

// Sign-up is open, so an attacker can mint accounts to multiply the per-user
// budget. Layered budgets: per user|ip, per ip (all accounts), and a global
// endpoint-wide cap. All three counters are bumped on every attempt.
async function rateLimited(userId: string, ip: string): Promise<boolean> {
  // Opportunistic cleanup of long-expired counter rows (fire-and-forget).
  db.delete(claimAttemptsTable)
    .where(lt(claimAttemptsTable.resetAt, sql`now() - make_interval(secs => ${WINDOW_MS / 1000})`))
    .catch(() => {});
  const [perUser, perIp, global] = await Promise.all([
    bumpAndCheck(`u|${userId}|${ip}`, MAX_ATTEMPTS),
    bumpAndCheck(`ip|${ip}`, MAX_ATTEMPTS_PER_IP),
    bumpAndCheck("global", MAX_ATTEMPTS_GLOBAL),
  ]);
  return perUser || perIp || global;
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

    if (await rateLimited(userId, req.ip ?? "?")) {
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
    res.json(toSiteDto(updated[0]));
  } catch (err) {
    next(err);
  }
});

export default router;
