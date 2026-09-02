import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { actionItemsTable, db, sitesTable } from "@workspace/db";
import { autoCloseActionItem } from "./actionQueue";
import { applyActionReviews } from "./opportunitiesSheet";

describe("action queue optimistic locking", () => {
  it("prevents an old sheet row from reopening an auto-closed opportunity", async () => {
    const suffix = `${Date.now()}-${process.pid}`;
    const [site] = await db
      .insert(sitesTable)
      .values({
        domain: `opportunities-${suffix}.test`,
        host: `opportunities-${suffix}.test`,
        displayName: "Opportunities optimistic lock test",
      })
      .returning({ id: sitesTable.id });

    try {
      const [action] = await db
        .insert(actionItemsTable)
        .values({
          siteId: site!.id,
          dedupeKey: `optimistic-lock:${suffix}`,
          actionType: "optimize_content",
          targetUrl: `https://opportunities-${suffix}.test/page`,
          status: "open",
          owner: "Ava",
          dueDate: "2026-09-15",
          market: "US",
        })
        .returning({
          id: actionItemsTable.id,
          version: actionItemsTable.version,
        });

      await autoCloseActionItem(site!.id, action!.id);
      const review = await applyActionReviews(site!.id, [{
        id: action!.id,
        expectedVersion: action!.version,
        status: "open",
        owner: null,
        dueDate: null,
        market: "global",
      }]);

      expect(review).toEqual({ updated: 0, stale: 1, invalid: 0 });
      const [stored] = await db
        .select({
          status: actionItemsTable.status,
          resolution: actionItemsTable.resolution,
          version: actionItemsTable.version,
        })
        .from(actionItemsTable)
        .where(
          and(
            eq(actionItemsTable.siteId, site!.id),
            eq(actionItemsTable.id, action!.id),
          ),
        );
      expect(stored).toMatchObject({
        status: "done",
        resolution: "auto",
        version: action!.version + 1,
      });

      const statusOnly = await applyActionReviews(site!.id, [{
        id: action!.id,
        expectedVersion: action!.version + 1,
        status: "dismissed",
      }]);
      expect(statusOnly).toEqual({ updated: 1, stale: 0, invalid: 0 });

      const ownerOnly = await applyActionReviews(site!.id, [{
        id: action!.id,
        expectedVersion: action!.version + 2,
        owner: null,
      }]);
      expect(ownerOnly).toEqual({ updated: 1, stale: 0, invalid: 0 });

      const [partiallyUpdated] = await db
        .select({
          status: actionItemsTable.status,
          owner: actionItemsTable.owner,
          dueDate: actionItemsTable.dueDate,
          market: actionItemsTable.market,
        })
        .from(actionItemsTable)
        .where(eq(actionItemsTable.id, action!.id));
      expect(partiallyUpdated).toEqual({
        status: "dismissed",
        owner: null,
        dueDate: "2026-09-15",
        market: "US",
      });
    } finally {
      await db.delete(actionItemsTable).where(eq(actionItemsTable.siteId, site!.id));
      await db.delete(sitesTable).where(eq(sitesTable.id, site!.id));
    }
  });
});