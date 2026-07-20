import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { queryGa4Pages, type Ga4Channel } from "../integrations/ga4";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateRange(
  req: { query: Record<string, unknown> },
): { startDate: string; endDate: string } | { error: string } {
  const startDate = String(req.query["startDate"] ?? "");
  const endDate = String(req.query["endDate"] ?? "");
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { error: "startDate and endDate must be YYYY-MM-DD" };
  }
  if (startDate > endDate) return { error: "startDate must be <= endDate" };
  return { startDate, endDate };
}

router.get("/ga4/pages", requireAuth, async (req, res) => {
  const v = validateRange(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const c = String(req.query["channel"] ?? "organic");
  if (c !== "organic" && c !== "all") {
    res.status(400).json({ error: "channel must be 'organic' or 'all'" });
    return;
  }
  const channel: Ga4Channel = c;
  try {
    const data = await queryGa4Pages({ ...v, channel });
    res.json({ startDate: v.startDate, endDate: v.endDate, channel, ...data });
  } catch (err) {
    req.log.error({ err }, "GA4 pages failed");
    res.status(502).json({ error: "GA4 fetch failed" });
  }
});

export default router;
