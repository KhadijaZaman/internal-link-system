import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  linkStatsTable,
  linkSuggestionsTable,
  queryLosersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

const CAP = 500;

interface UrlItem {
  url: string;
  label?: string | null;
  sublabel?: string | null;
  count?: number | null;
}

const ALLOWED = new Set([
  "pages",
  "links",
  "orphans",
  "dead-ends",
  "pending-suggestions",
  "critical-losers",
]);

router.get("/dashboard/urls/:type", requireAuth, async (req, res) => {
  const type = String(req.params.type ?? "");
  if (!ALLOWED.has(type)) {
    res.status(400).json({ error: "Invalid type" });
    return;
  }

  let items: UrlItem[] = [];
  let total = 0;

  if (type === "pages") {
    const rows = await db
      .select({
        url: linkStatsTable.url,
        inbound: linkStatsTable.inboundCount,
        outbound: linkStatsTable.outboundCount,
        pagerank: linkStatsTable.internalPagerank,
      })
      .from(linkStatsTable)
      .orderBy(desc(linkStatsTable.internalPagerank))
      .limit(CAP);
    const [{ c = 0 } = { c: 0 }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(linkStatsTable);
    total = Number(c);
    items = rows.map((r) => ({
      url: r.url,
      sublabel: `${r.inbound} in · ${r.outbound} out`,
      count: r.inbound,
    }));
  } else if (type === "orphans") {
    const rows = await db
      .select({
        url: linkStatsTable.url,
        outbound: linkStatsTable.outboundCount,
      })
      .from(linkStatsTable)
      .where(eq(linkStatsTable.isOrphan, true))
      .orderBy(desc(linkStatsTable.outboundCount))
      .limit(CAP);
    total = rows.length;
    items = rows.map((r) => ({
      url: r.url,
      sublabel: `0 inbound · ${r.outbound} outbound`,
    }));
  } else if (type === "dead-ends") {
    const rows = await db
      .select({
        url: linkStatsTable.url,
        inbound: linkStatsTable.inboundCount,
      })
      .from(linkStatsTable)
      .where(eq(linkStatsTable.isDeadEnd, true))
      .orderBy(desc(linkStatsTable.inboundCount))
      .limit(CAP);
    total = rows.length;
    items = rows.map((r) => ({
      url: r.url,
      sublabel: `${r.inbound} inbound · 0 outbound`,
    }));
  } else if (type === "links") {
    // Show the top "linker" pages — sources with the most outbound links.
    const rows = await db
      .select({
        url: linkStatsTable.url,
        outbound: linkStatsTable.outboundCount,
        inbound: linkStatsTable.inboundCount,
      })
      .from(linkStatsTable)
      .orderBy(desc(linkStatsTable.outboundCount))
      .limit(CAP);
    const [{ c = 0 } = { c: 0 }] = await db
      .select({ c: sql<number>`COALESCE(SUM(${linkStatsTable.outboundCount}), 0)::int` })
      .from(linkStatsTable);
    total = Number(c);
    items = rows
      .filter((r) => r.outbound > 0)
      .map((r) => ({
        url: r.url,
        sublabel: `${r.outbound} outbound · ${r.inbound} inbound`,
        count: r.outbound,
      }));
  } else if (type === "pending-suggestions") {
    const rows = await db
      .select({
        id: linkSuggestionsTable.id,
        donorUrl: linkSuggestionsTable.donorUrl,
        receiverUrl: linkSuggestionsTable.receiverUrl,
        anchorText: linkSuggestionsTable.anchorText,
        priorityScore: linkSuggestionsTable.priorityScore,
      })
      .from(linkSuggestionsTable)
      .where(eq(linkSuggestionsTable.status, "pending_review"))
      .orderBy(desc(linkSuggestionsTable.priorityScore))
      .limit(CAP);
    total = rows.length;
    items = rows.map((r) => ({
      url: r.donorUrl,
      label: r.anchorText ?? "(no anchor)",
      sublabel: `→ ${r.receiverUrl}`,
      count: r.priorityScore != null ? Math.round(r.priorityScore * 100) : null,
    }));
  } else if (type === "critical-losers") {
    const rows = await db
      .select({
        url: queryLosersTable.url,
        query: queryLosersTable.query,
        positionChange: queryLosersTable.positionChange,
        currPosition: queryLosersTable.currPosition,
        impressionsChangePct: queryLosersTable.impressionsChangePct,
      })
      .from(queryLosersTable)
      .where(eq(queryLosersTable.severity, "critical"))
      .orderBy(desc(queryLosersTable.positionChange))
      .limit(CAP);
    total = rows.length;
    items = rows.map((r) => {
      const pos = r.currPosition != null ? r.currPosition.toFixed(1) : "—";
      const chg = r.positionChange != null ? (r.positionChange > 0 ? `+${r.positionChange.toFixed(1)}` : r.positionChange.toFixed(1)) : "—";
      const imp = r.impressionsChangePct != null ? `${Math.round(r.impressionsChangePct)}%` : "—";
      return {
        url: r.url,
        label: r.query,
        sublabel: `pos ${pos} (${chg}) · impressions ${imp}`,
      };
    });
  }

  res.json({ type, total, returned: items.length, items });
});

export default router;
