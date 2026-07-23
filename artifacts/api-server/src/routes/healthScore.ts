import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { computeHealthScore, explainHealthChange, getHealthTrend } from "../services/health";

const router: IRouter = Router();

router.get("/health-score", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const health = await computeHealthScore(site.id);
  const [trend, decline] = await Promise.all([
    getHealthTrend(site.id),
    explainHealthChange(site.id, health),
  ]);
  res.json({
    generatedAt: new Date().toISOString(),
    score: health.score,
    label: health.label,
    components: health.components,
    trend,
    decline,
  });
});

export default router;
