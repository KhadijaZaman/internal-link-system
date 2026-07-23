import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { GetImpactDetailQueryParams } from "@workspace/api-zod";
import { computeImpactWins, computeImpactDetail } from "../services/impact";

const router: IRouter = Router();

router.get("/impact/wins", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const { summary, items } = await computeImpactWins(site.id);
  res.json({ generatedAt: new Date().toISOString(), summary, items });
});

router.get("/impact/detail", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  // zod.coerce.string() would stringify undefined, so guard the raw type first.
  const parsed =
    typeof req.query.url === "string"
      ? GetImpactDetailQueryParams.safeParse({ url: req.query.url })
      : ({ success: false } as const);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid url" });
    return;
  }
  const detail = await computeImpactDetail(site.id, parsed.data.url);
  res.json(detail);
});

export default router;
