import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { computeHealthScore, explainHealthChange, getHealthTrend } from "../services/health";

const router: IRouter = Router();

router.get("/health-score", requireAuth, async (_req, res) => {
  const health = await computeHealthScore();
  const [trend, decline] = await Promise.all([getHealthTrend(), explainHealthChange(health)]);
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
