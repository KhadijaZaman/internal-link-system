import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { computeHealthScore, getHealthTrend } from "../services/health";

const router: IRouter = Router();

router.get("/health-score", requireAuth, async (_req, res) => {
  const [health, trend] = await Promise.all([computeHealthScore(), getHealthTrend()]);
  res.json({
    generatedAt: new Date().toISOString(),
    score: health.score,
    label: health.label,
    components: health.components,
    trend,
  });
});

export default router;
