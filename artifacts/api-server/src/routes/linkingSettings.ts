import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, linkingSettingsTable, type LinkingSettings } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { UpdateLinkingSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function loadOrCreate(): Promise<LinkingSettings> {
  const rows = await db.select().from(linkingSettingsTable).limit(1);
  if (rows.length > 0) return rows[0]!;
  const inserted = await db
    .insert(linkingSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await db.select().from(linkingSettingsTable).limit(1);
  return again[0]!;
}

function serialize(s: LinkingSettings) {
  return {
    similarityThreshold: s.similarityThreshold,
    densityMinPer1000: s.densityMinPer1000,
    densityMaxPer1000: s.densityMaxPer1000,
    hubDensityMaxPer1000: s.hubDensityMaxPer1000,
    moneyDensityMaxPer1000: s.moneyDensityMaxPer1000,
    shortPageMaxLinks: s.shortPageMaxLinks,
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}

router.get("/linking-settings", requireAuth, async (_req, res) => {
  const s = await loadOrCreate();
  res.json(serialize(s));
});

router.put("/linking-settings", requireAuth, async (req, res) => {
  const parsed = UpdateLinkingSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  await loadOrCreate();
  const updates: Partial<LinkingSettings> = {};
  if (parsed.data.similarityThreshold !== undefined)
    updates.similarityThreshold = parsed.data.similarityThreshold;
  if (parsed.data.densityMinPer1000 !== undefined)
    updates.densityMinPer1000 = parsed.data.densityMinPer1000;
  if (parsed.data.densityMaxPer1000 !== undefined)
    updates.densityMaxPer1000 = parsed.data.densityMaxPer1000;
  if (parsed.data.hubDensityMaxPer1000 !== undefined)
    updates.hubDensityMaxPer1000 = parsed.data.hubDensityMaxPer1000;
  if (parsed.data.moneyDensityMaxPer1000 !== undefined)
    updates.moneyDensityMaxPer1000 = parsed.data.moneyDensityMaxPer1000;
  if (parsed.data.shortPageMaxLinks !== undefined)
    updates.shortPageMaxLinks = parsed.data.shortPageMaxLinks;
  updates.updatedAt = new Date();
  await db.update(linkingSettingsTable).set(updates).where(eq(linkingSettingsTable.id, 1));
  const after = await loadOrCreate();
  res.json(serialize(after));
});

export default router;
