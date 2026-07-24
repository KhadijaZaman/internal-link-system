import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, usersTable, sitesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

/**
 * Cross-tenant admin overview: every registered user and every site they
 * added, newest first. Deliberately NOT requireSite (global scope) and
 * deliberately returns registry fields only — never credentials, never any
 * tenant's SEO data.
 */
router.get("/admin/overview", requireAuth, requireAdmin, async (req, res) => {
  const [users, sites] = await Promise.all([
    db.select().from(usersTable).orderBy(desc(usersTable.createdAt)),
    db
      .select({
        id: sitesTable.id,
        ownerUserId: sitesTable.ownerUserId,
        domain: sitesTable.domain,
        host: sitesTable.host,
        displayName: sitesTable.displayName,
        createdAt: sitesTable.createdAt,
      })
      .from(sitesTable)
      .orderBy(desc(sitesTable.createdAt)),
  ]);

  // Emails live in Clerk, not in the local mirror table. Fail-soft: if the
  // Clerk lookup errors, the overview still renders with ids only.
  const emailById = new Map<string, string>();
  try {
    const list = await clerkClient.users.getUserList({
      userId: users.map((u) => u.id),
      limit: 500,
    });
    for (const cu of list.data) {
      const email = cu.primaryEmailAddress?.emailAddress ?? cu.emailAddresses[0]?.emailAddress;
      if (email) emailById.set(cu.id, email);
    }
  } catch (err) {
    req.log.warn({ err }, "Clerk user list lookup failed; admin overview will show ids only");
  }

  const sitesByOwner = new Map<string, typeof sites>();
  for (const s of sites) {
    if (!s.ownerUserId) continue;
    const arr = sitesByOwner.get(s.ownerUserId) ?? [];
    arr.push(s);
    sitesByOwner.set(s.ownerUserId, arr);
  }

  const toSite = (s: (typeof sites)[number]) => ({
    id: s.id,
    domain: s.domain,
    host: s.host,
    displayName: s.displayName,
    createdAt: s.createdAt.toISOString(),
  });

  res.json({
    totals: { users: users.length, sites: sites.length },
    users: users.map((u) => ({
      id: u.id,
      email: emailById.get(u.id) ?? null,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt.toISOString(),
      sites: (sitesByOwner.get(u.id) ?? []).map(toSite),
    })),
    unclaimedSites: sites.filter((s) => !s.ownerUserId).map(toSite),
  });
});

export default router;
